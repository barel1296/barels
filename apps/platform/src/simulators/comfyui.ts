/**
 * SIMULATED ComfyUI HTTP API for automated tests of the ComfyUI bridge. It is
 * NOT ComfyUI: there are no models and no GPU. It validates prompts against a
 * small node catalogue (unknown nodes, values not in list, missing input
 * images), runs one prompt at a time, renders deterministic PNGs from the
 * bound inputs (so tests can prove what reached the graph), and supports
 * queue removal, targeted interrupts, uploads, /view, /free and fault
 * injection (OOM, node errors, hangs). Real ComfyUI behaviour must be
 * verified on the workstation.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { sha256Hex } from '../lib/canonical-json.js';
import { encodeSolidPng } from '../lib/png.js';
import type { ComfyPrompt } from '../comfy-bridge/comfy-client.js';

const GB = 1024 * 1024 * 1024;

interface SimPrompt {
  id: string;
  number: number;
  prompt: ComfyPrompt;
  clientId: string;
}

export interface ComfySimulator {
  app: FastifyInstance;
  baseUrl: string;
  prompts: SimPrompt[];
  uploads: Map<string, Buffer>;
  interrupts: (string | null)[];
  frees: { unload_models: boolean; free_memory: boolean }[];
  /** Model files the loader nodes accept (stand-ins; the bridge never chooses them). */
  models: { checkpoints: string[]; loras: string[] };
  execMs: number;
  failNext(exceptionType: string, message: string): void;
  hangNext(): void;
  /** Queues a prompt as if a person used the ComfyUI UI (the bridge must not touch it). */
  foreignPrompt(): string;
  close(): Promise<void>;
}

export async function startComfySimulator(): Promise<ComfySimulator> {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  const prompts: SimPrompt[] = [];
  const pending: SimPrompt[] = [];
  let running: { p: SimPrompt; startedAt: number; hang: boolean; fail: { type: string; message: string } | null } | null = null;
  const history = new Map<string, unknown>();
  const outputs = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer>();
  const interrupts: (string | null)[] = [];
  const frees: { unload_models: boolean; free_memory: boolean }[] = [];
  const faults: ({ kind: 'fail'; type: string; message: string } | { kind: 'hang' })[] = [];
  let number = 0;

  app.addContentTypeParser(/^multipart\/form-data/, { parseAs: 'buffer' }, (req, body, done) => done(null, parseMultipart(String(req.headers['content-type']), body as Buffer)));

  const catalogue: Record<string, Record<string, unknown>> = {
    CheckpointLoaderSimple: { ckpt_name: () => sim.models.checkpoints },
    LoraLoader: { lora_name: () => sim.models.loras, strength_model: 'FLOAT', strength_clip: 'FLOAT' },
    CLIPTextEncode: { text: 'STRING' },
    EmptyLatentImage: { width: 'INT', height: 'INT', batch_size: 'INT' },
    KSampler: { seed: 'INT', steps: 'INT', cfg: 'FLOAT', sampler_name: 'STRING', scheduler: 'STRING', denoise: 'FLOAT' },
    VAEDecode: {},
    LoadImage: { image: 'IMAGE_FILE' },
    SaveImage: { filename_prefix: 'STRING' },
  };

  function validate(prompt: ComfyPrompt): { error: unknown; node_errors: Record<string, unknown> } | null {
    const nodeErrors: Record<string, unknown> = {};
    for (const [id, node] of Object.entries(prompt)) {
      const spec = catalogue[node.class_type];
      if (!spec) return { error: { type: 'invalid_prompt', message: `Cannot execute because node ${node.class_type} does not exist.`, details: `Node ID '#${id}'` }, node_errors: {} };
      for (const [input, kind] of Object.entries(spec)) {
        const v = node.inputs[input];
        if (typeof kind === 'function') {
          const allowed = (kind as () => string[])();
          if (!allowed.includes(String(v))) {
            nodeErrors[id] = { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: `${input}: '${String(v)}' not in ${JSON.stringify(allowed)}` }], class_type: node.class_type };
          }
        } else if (kind === 'IMAGE_FILE' && !uploads.has(String(v))) {
          nodeErrors[id] = { errors: [{ type: 'custom_validation_failed', message: 'Custom validation failed for node', details: `image - Invalid image file: ${String(v)}` }], class_type: node.class_type };
        }
      }
    }
    return Object.keys(nodeErrors).length ? { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: nodeErrors } : null;
  }

  function render(p: SimPrompt): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const g = p.prompt;
    const texts = Object.values(g).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => String(n.inputs.text));
    const seed = Object.values(g).find((n) => n.class_type === 'KSampler')?.inputs.seed;
    const loras = Object.values(g).filter((n) => n.class_type === 'LoraLoader').map((n) => `${String(n.inputs.lora_name)}@${String(n.inputs.strength_model)}`);
    const refs = Object.values(g).filter((n) => n.class_type === 'LoadImage').map((n) => sha256Hex(uploads.get(String(n.inputs.image)) ?? Buffer.alloc(0)));
    const latent = Object.values(g).find((n) => n.class_type === 'EmptyLatentImage')?.inputs ?? {};
    const count = Number(latent.batch_size ?? 1);
    const w = Math.max(8, Math.round(Number(latent.width ?? 512) / 8));
    const h = Math.max(8, Math.round(Number(latent.height ?? 512) / 8));
    const colour = sha256Hex(JSON.stringify({ texts, seed, loras, refs }));
    for (const [id, node] of Object.entries(g)) {
      if (node.class_type !== 'SaveImage') continue;
      const images = [];
      for (let i = 0; i < count; i++) {
        const filename = `${String(node.inputs.filename_prefix ?? 'ComfyUI')}_${String(p.number).padStart(5, '0')}_${i}.png`;
        const c = colour.slice(i * 6, i * 6 + 6);
        outputs.set(`output/${filename}`, encodeSolidPng(w, h, [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]));
        images.push({ filename, subfolder: '', type: 'output' });
      }
      out[id] = { images };
    }
    return out;
  }

  const tick = setInterval(() => {
    const now = Date.now();
    if (running && !running.hang && now - running.startedAt >= sim.execMs) {
      const r = running;
      running = null;
      const msgs: [string, Record<string, unknown>][] = [['execution_start', { prompt_id: r.p.id, timestamp: r.startedAt }]];
      if (r.fail) {
        msgs.push(['execution_error', { prompt_id: r.p.id, exception_type: r.fail.type, exception_message: r.fail.message, node_type: 'KSampler', timestamp: now }]);
        history.set(r.p.id, { prompt: [r.p.number, r.p.id, r.p.prompt, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: msgs } });
      } else {
        msgs.push(['execution_success', { prompt_id: r.p.id, timestamp: now }]);
        history.set(r.p.id, { prompt: [r.p.number, r.p.id, r.p.prompt, {}, []], outputs: render(r.p), status: { status_str: 'success', completed: true, messages: msgs } });
      }
    }
    if (!running && pending.length) {
      const p = pending.shift()!;
      const f = faults.shift();
      running = { p, startedAt: Date.now(), hang: f?.kind === 'hang', fail: f?.kind === 'fail' ? { type: f.type, message: f.message } : null };
    }
  }, 10);

  app.get('/system_stats', async () => ({
    system: { os: 'simulated', comfyui_version: '0.0.0-simulated', python_version: '3.12.0', pytorch_version: 'simulated', embedded_python: false, ram_total: 64 * GB, ram_free: 32 * GB },
    devices: [{ name: 'SIMULATED GPU (no hardware)', type: 'cuda', index: 0, vram_total: 24 * GB, vram_free: running ? 10 * GB : 20 * GB, torch_vram_total: 0, torch_vram_free: 0 }],
  }));

  app.get('/object_info', async () =>
    Object.fromEntries(
      Object.entries(catalogue).map(([cls, spec]) => [
        cls,
        { input: { required: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'function' ? [(v as () => string[])()] : [v]])) }, output: [], name: cls, category: 'simulated' },
      ]),
    ),
  );

  app.post('/prompt', async (req, reply) => {
    const body = req.body as { prompt: ComfyPrompt; client_id?: string };
    const invalid = validate(body.prompt);
    if (invalid) return reply.status(400).send(invalid);
    const p: SimPrompt = { id: randomUUID(), number: number++, prompt: body.prompt, clientId: body.client_id ?? '' };
    prompts.push(p);
    pending.push(p);
    return { prompt_id: p.id, number: p.number, node_errors: {} };
  });

  app.get('/queue', async () => ({
    queue_running: running ? [[running.p.number, running.p.id, running.p.prompt, { client_id: running.p.clientId }, []]] : [],
    queue_pending: pending.map((p) => [p.number, p.id, p.prompt, { client_id: p.clientId }, []]),
  }));

  app.post('/queue', async (req) => {
    const body = req.body as { delete?: string[]; clear?: boolean };
    for (const id of body.delete ?? []) {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    }
    return {};
  });

  app.post('/interrupt', async (req) => {
    const body = (req.body ?? {}) as { prompt_id?: string };
    interrupts.push(body.prompt_id ?? null);
    if (running && (!body.prompt_id || body.prompt_id === running.p.id)) {
      const r = running;
      running = null;
      history.set(r.p.id, {
        prompt: [r.p.number, r.p.id, r.p.prompt, {}, []],
        outputs: {},
        status: { status_str: 'error', completed: false, messages: [['execution_start', { timestamp: r.startedAt }], ['execution_interrupted', { prompt_id: r.p.id, timestamp: Date.now() }]] },
      });
    }
    return {};
  });

  app.get<{ Params: { id: string } }>('/history/:id', async (req) => (history.has(req.params.id) ? { [req.params.id]: history.get(req.params.id) } : {}));

  app.get<{ Querystring: { filename: string; subfolder?: string; type?: string } }>('/view', async (req, reply) => {
    const q = req.query;
    const key = q.type === 'input' ? `${q.subfolder ? `${q.subfolder}/` : ''}${q.filename}` : `output/${q.subfolder ? `${q.subfolder}/` : ''}${q.filename}`;
    const bytes = q.type === 'input' ? uploads.get(key) : outputs.get(key);
    if (!bytes) return reply.status(404).send('not found');
    return reply.header('content-type', 'image/png').send(bytes);
  });

  app.post('/upload/image', async (req, reply) => {
    const form = req.body as { fields: Record<string, string>; files: { field: string; filename: string; bytes: Buffer }[] };
    const file = form.files.find((f) => f.field === 'image');
    if (!file) return reply.status(400).send('no image');
    const sub = form.fields.subfolder ?? '';
    let name = file.filename;
    const key = (n: string) => (sub ? `${sub}/${n}` : n);
    if (uploads.has(key(name)) && form.fields.overwrite !== 'true') {
      if (!uploads.get(key(name))!.equals(file.bytes)) name = `${name.replace(/(\.\w+)$/, '')} (1)${name.match(/(\.\w+)$/)?.[1] ?? ''}`;
    }
    uploads.set(key(name), file.bytes);
    return { name, subfolder: sub, type: 'input' };
  });

  app.post('/free', async (req) => {
    const b = (req.body ?? {}) as { unload_models?: boolean; free_memory?: boolean };
    frees.push({ unload_models: Boolean(b.unload_models), free_memory: Boolean(b.free_memory) });
    return {};
  });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const sim: ComfySimulator = {
    app,
    baseUrl: address,
    prompts,
    uploads,
    interrupts,
    frees,
    models: { checkpoints: ['sim-base.safetensors'], loras: ['sim-none.safetensors', 'sim-lora-a.safetensors'] },
    execMs: 30,
    failNext: (type, message) => faults.push({ kind: 'fail', type, message }),
    hangNext: () => faults.push({ kind: 'hang' }),
    foreignPrompt() {
      const p: SimPrompt = {
        id: randomUUID(),
        number: number++,
        prompt: { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'someone-else' } } },
        clientId: 'comfyui-web-ui',
      };
      pending.push(p);
      faults.unshift({ kind: 'hang' });
      return p.id;
    },
    close: async () => {
      clearInterval(tick);
      await app.close();
    },
  };
  return sim;
}

function parseMultipart(contentType: string, body: Buffer): { fields: Record<string, string>; files: { field: string; filename: string; bytes: Buffer }[] } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const fields: Record<string, string> = {};
  const files: { field: string; filename: string; bytes: Buffer }[] = [];
  if (!boundary) return { fields, files };
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let pos = body.indexOf(sep);
  while (pos >= 0) {
    const next = body.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = body.subarray(pos + sep.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      if (name && filename !== undefined) files.push({ field: name, filename, bytes: Buffer.from(content) });
      else if (name) fields[name] = content.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}
