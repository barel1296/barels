import { EngineCallError } from '../../contract/client.js';
import type { ErrorObject, JobStatus, Output, WorkflowManifest } from '../../contract/types.js';
import { withTx } from '../../db/tx.js';
import { sha256Hex } from '../../lib/canonical-json.js';
import { EXTENSION_BY_MIME, type MediaMime, kindOfMime, readDimensions, sniffMime } from '../../lib/media.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Services } from '../../services.js';
import { audit } from '../audit.js';
import type { EngineRow } from './engines.js';
import { type JobRow, WORKER_ACTOR, failAttempt, onTerminal, recordEvent, transition } from './jobs.js';
import { type Threshold, effectiveThresholds, evaluateQa } from './qa.js';

/** IPTC digital source type for media created by a generative model. */
const IPTC_TRAINED_ALGORITHMIC_MEDIA = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

class VerificationError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface VerifiedOutput {
  output: Output;
  bytes: Buffer;
  mime: MediaMime;
  width: number | null;
  height: number | null;
}

/**
 * Downloads and verifies one output (contract §11): exact bytes and sha256,
 * MIME by magic bytes, declared dimensions, manifest output kind/types, and
 * provenance pointing at the job's workflow version.
 */
async function verifyOutput(svc: Services, engine: EngineRow, job: JobRow, manifest: WorkflowManifest, output: Output): Promise<VerifiedOutput> {
  const where = { output_id: output.output_id };
  if (output.provenance.workflow_key !== job.workflow_key || output.provenance.workflow_version !== job.workflow_version) {
    throw new VerificationError('output provenance names a different workflow version', {
      ...where,
      expected: `${job.workflow_key}@${job.workflow_version}`,
      received: `${output.provenance.workflow_key}@${output.provenance.workflow_version}`,
    });
  }
  if (output.kind !== manifest.outputs.kind || !manifest.outputs.mime_types.includes(output.mime_type)) {
    throw new VerificationError('output kind or MIME type not declared by the manifest', { ...where, kind: output.kind, mime_type: output.mime_type });
  }
  if (!output.download_url) throw new VerificationError('output has no download_url (http_download transfer)', where);
  const client = svc.engineClients.forRow(engine);
  const { bytes, contentType, headerSha256 } = await client.download(output.download_url);
  const sha = sha256Hex(bytes);
  if (bytes.length !== output.bytes) throw new VerificationError('downloaded size differs from declared bytes', { ...where, declared: output.bytes, received: bytes.length });
  if (sha !== output.sha256) throw new VerificationError('sha256 mismatch', { ...where, declared: output.sha256, computed: sha });
  if (headerSha256 && headerSha256 !== output.sha256) throw new VerificationError('X-Content-SHA256 header differs from declared sha256', { ...where, header: headerSha256 });
  const mime = sniffMime(bytes);
  if (mime !== output.mime_type) throw new VerificationError('content does not match declared MIME type', { ...where, declared: output.mime_type, sniffed: mime });
  if (contentType && !contentType.startsWith(output.mime_type)) {
    throw new VerificationError('Content-Type header differs from declared MIME type', { ...where, header: contentType });
  }
  if (kindOfMime(mime) !== output.kind) throw new VerificationError('output kind does not match content', { ...where, kind: output.kind, mime });
  const dims = readDimensions(bytes, mime);
  if (dims && ((output.width && dims.width !== output.width) || (output.height && dims.height !== output.height))) {
    throw new VerificationError('image dimensions differ from declared width/height', { ...where, declared: [output.width, output.height], actual: [dims.width, dims.height] });
  }
  return { output, bytes, mime, width: dims?.width ?? output.width ?? null, height: dims?.height ?? output.height ?? null };
}

/**
 * Ingests a succeeded engine job: verify every output, store it in the
 * platform's content store, record provenance and QA, decide per platform
 * thresholds, and complete the job. Any verification failure fails the attempt
 * (OUTPUT_VERIFICATION_FAILED, transient → retried as attempt+1).
 */
export async function ingestOutputs(svc: Services, engine: EngineRow, job: JobRow, status: JobStatus): Promise<void> {
  const pool = svc.workerPool;
  const policy = { baseMs: svc.config.worker.retryBaseMs, maxMs: svc.config.worker.retryMaxMs };
  const usage = {
    gpuSeconds: status.resource_usage?.gpu_seconds ?? 0,
    wallSeconds: status.resource_usage?.wall_seconds ?? 0,
    resourceUsage: status.resource_usage ?? null,
  };
  const wf = await pool.query<{ manifest: WorkflowManifest; manifest_sha256: string }>(
    'SELECT manifest, manifest_sha256 FROM inference.visual_workflows WHERE id = $1',
    [job.workflow_id],
  );
  const manifest = wf.rows[0]!.manifest;
  const outputs = status.outputs ?? [];

  const verified: VerifiedOutput[] = [];
  try {
    if (outputs.length === 0 || outputs.length > job.output_count) {
      throw new VerificationError('unexpected number of outputs', { requested: job.output_count, received: outputs.length });
    }
    for (const output of outputs) {
      const v = await verifyOutput(svc, engine, job, manifest, output);
      await recordEvent(pool, job, {
        type: 'output_verified',
        actor: WORKER_ACTOR,
        details: { output_id: output.output_id, sha256: output.sha256, bytes: output.bytes, mime_type: v.mime, width: v.width, height: v.height },
      });
      verified.push(v);
    }
  } catch (err) {
    const error: ErrorObject =
      err instanceof VerificationError
        ? { code: 'OUTPUT_VERIFICATION_FAILED', class: 'transient', message: err.message, retryable: true, details: err.details }
        : err instanceof EngineCallError
          ? { code: 'OUTPUT_VERIFICATION_FAILED', class: 'transient', message: `download failed: ${err.message}`, retryable: true, details: { engine_error: err.error } }
          : { code: 'OUTPUT_VERIFICATION_FAILED', class: 'transient', message: (err as Error).message, retryable: true };
    await recordEvent(pool, job, { type: 'output_rejected', actor: WORKER_ACTOR, details: { error } });
    await failAttempt(pool, job, error, WORKER_ACTOR, policy, usage);
    return;
  }

  // Files first (content-addressed, idempotent); rows in one transaction.
  const keys = verified.map((v) => svc.store.keyFor(job.workspace_id, job.influencer_id, v.output.sha256, EXTENSION_BY_MIME[v.mime]));
  for (const [i, v] of verified.entries()) await svc.store.put(keys[i]!, v.bytes, v.output.sha256);

  await withTx(pool, async (db) => {
    const thresholdRows = await db.query<Threshold>(
      `SELECT id, influencer_id, check_key, min_score::float8 AS min_score, max_score::float8 AS max_score, required, on_fail
         FROM identity.qa_thresholds
        WHERE workspace_id = $1 AND status = 'active' AND (influencer_id IS NULL OR influencer_id = $2)`,
      [job.workspace_id, job.influencer_id],
    );
    const thresholds = effectiveThresholds(thresholdRows.rows, job.influencer_id);
    const assetIds: string[] = [];
    let rejected = 0;
    for (const [i, v] of verified.entries()) {
      const o = v.output;
      const decision = evaluateQa(o.qa ?? [], thresholds);
      const provenance = {
        contract: o.provenance,
        engine: { engine_id: engine.id, engine_key: engine.engine_key, engine_kind: job.engine_kind, reported: status.engine },
        visual_job_id: job.id,
        request_id: job.request_id,
        attempt: job.attempt,
        engine_job_id: job.engine_job_id,
        workflow: { key: job.workflow_key, version: job.workflow_version, manifest_sha256: wf.rows[0]!.manifest_sha256 },
        persona_version_id: job.persona_version_id,
        persona_reference_ids: job.persona_reference_ids,
        reference_asset_ids: job.references.map((r) => r.asset_id),
        adapter_ids: job.adapter_ids,
        iptc_digital_source_type: IPTC_TRAINED_ALGORITHMIC_MEDIA,
        contract_mock: job.engine_kind === 'contract_mock',
        output_metadata: o.metadata ?? {},
      };
      const qaSummary = {
        decision: decision.status,
        flagged: decision.flagged,
        reasons: decision.reasons,
        outcomes: decision.outcomes,
        engine_qa: o.qa ?? [],
        validation_scope: job.engine_kind === 'contract_mock' ? 'contract_mock' : 'real_engine',
      };
      const engineOutputId = `${job.engine_job_id}/${o.output_id}`;
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height,
           duration_ms, sha256, origin, provenance, c2pa_embedded, status, visual_job_id, engine_output_id, engine_kind,
           qa_summary, status_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'generated', $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (visual_job_id, engine_output_id) WHERE visual_job_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          uuidv7(),
          job.workspace_id,
          job.influencer_id,
          o.kind,
          keys[i],
          v.mime,
          v.bytes.length,
          v.width,
          v.height,
          o.duration_ms ?? null,
          Buffer.from(o.sha256, 'hex'),
          JSON.stringify(provenance),
          o.provenance.c2pa?.signed === true,
          decision.status,
          job.id,
          engineOutputId,
          job.engine_kind,
          JSON.stringify(qaSummary),
          decision.reasons.length > 0 ? decision.reasons.join('; ') : null,
        ],
      );
      let assetId = inserted.rows[0]?.id;
      if (!assetId) {
        const existing = await db.query<{ id: string }>(
          'SELECT id FROM content.media_assets WHERE visual_job_id = $1 AND engine_output_id = $2',
          [job.id, engineOutputId],
        );
        assetId = existing.rows[0]!.id;
      } else {
        await db.query(
          `INSERT INTO content.validation_results (workspace_id, subject_type, subject_id, check_type, provider, passed, details, check_key, advisory)
           VALUES ($1, 'media_asset', $2, 'technical', 'platform', true, $3, 'technical.verified_download', false)`,
          [job.workspace_id, assetId, JSON.stringify({ sha256: o.sha256, bytes: o.bytes, mime_sniffed: v.mime, width: v.width, height: v.height })],
        );
        for (const qa of o.qa ?? []) {
          await db.query(
            `INSERT INTO content.validation_results (workspace_id, subject_type, subject_id, check_type, provider, score, threshold,
               passed, details, check_key, advisory)
             VALUES ($1, 'media_asset', $2, 'engine_qa', $3, $4, $5, $6, $7, $8, true)`,
            [job.workspace_id, assetId, `engine:${engine.engine_key}`, qa.score ?? null, qa.threshold ?? null, qa.passed ?? false, JSON.stringify(qa.details ?? {}), qa.check],
          );
        }
        for (const outcome of decision.outcomes) {
          await db.query(
            `INSERT INTO content.validation_results (workspace_id, subject_type, subject_id, check_type, provider, score, passed,
               details, check_key, advisory)
             VALUES ($1, 'media_asset', $2, 'qa_threshold', 'platform', $3, $4, $5, $6, false)`,
            [job.workspace_id, assetId, outcome.score, outcome.passed, JSON.stringify(outcome), outcome.check_key],
          );
        }
        await audit(db, {
          workspaceId: job.workspace_id,
          influencerId: job.influencer_id,
          actor: WORKER_ACTOR,
          action: 'media_asset.ingest',
          subjectType: 'media_asset',
          subjectId: assetId,
          traceId: job.trace_id,
          metadata: {
            visual_job_id: job.id,
            sha256: o.sha256,
            qa_decision: decision.status,
            qa_reasons: decision.reasons,
            flagged: decision.flagged,
            engine_kind: job.engine_kind,
          },
        });
      }
      if (decision.status === 'rejected') rejected++;
      assetIds.push(assetId);
    }
    const succeeded = await transition(
      db,
      job,
      'succeeded',
      {
        finished_at: new Date(),
        output_asset_ids: assetIds,
        engine_state: 'succeeded',
        lease_owner: null,
        lease_expires_at: null,
        error: null,
        error_code: null,
        error_class: null,
        gpu_seconds: job.gpu_seconds + (usage.gpuSeconds ?? 0),
        wall_seconds: job.wall_seconds + (usage.wallSeconds ?? 0),
        resource_usage: usage.resourceUsage,
      },
      { type: 'succeeded', actor: WORKER_ACTOR, details: { asset_ids: assetIds, qa_rejected: rejected, engine_kind: job.engine_kind } },
    );
    if (succeeded) await onTerminal(db, succeeded, WORKER_ACTOR);
  });
}
