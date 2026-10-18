/**
 * Contract change process (README §14): every example validates against its
 * schema, fixtures are consistent, and the OpenAPI document references only
 * files that exist.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { paths } from '../../src/config.js';
import { type ContractSchemaName, ContractValidator } from '../../src/contract/validator.js';
import { manifestSha256 } from '../../src/lib/canonical-json.js';

const dir = paths.contractDir;
const v = new ContractValidator(dir);
const load = (p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8'));

const EXAMPLE_SCHEMA: Record<string, ContractSchemaName> = {
  'engine-info.json': 'engine-info',
  'workflow-list.json': 'workflow-list',
  'workflow-manifest.conformance-solid-color.json': 'workflow-manifest',
  'workflow-manifest.instagram-photo.json': 'workflow-manifest',
  'job-submission.json': 'job-submission',
  'job-status.queued.json': 'job-status',
  'job-status.running.json': 'job-status',
  'job-status.succeeded.json': 'job-status',
  'job-status.failed.json': 'job-status',
  'job-status.cancelled.json': 'job-status',
  'error.parameter-validation.json': 'error-response',
  'error.engine-busy.json': 'error-response',
  'resources.json': 'resource-state',
};

describe('Visual Engine Contract artifacts', () => {
  it('maps every example file to a schema', () => {
    assert.deepEqual(readdirSync(join(dir, 'examples')).sort(), Object.keys(EXAMPLE_SCHEMA).sort());
  });
  for (const [file, schema] of Object.entries(EXAMPLE_SCHEMA)) {
    it(`examples/${file} validates against ${schema}`, () => {
      const r = v.validate(schema, load(`examples/${file}`));
      assert.ok(r.ok, JSON.stringify(r.violations));
    });
  }
  it('the job-status schema enforces outputs on succeeded and error on failed', () => {
    const ok = load('examples/job-status.succeeded.json');
    assert.equal(v.validate('job-status', { ...ok, outputs: [] }).ok, false);
    assert.equal(v.validate('job-status', { ...load('examples/job-status.failed.json'), error: null }).ok, false);
  });
  it('workflow-list example carries the real manifest hash of the example manifest', () => {
    const list = load('examples/workflow-list.json');
    assert.equal(list.workflows[0].manifest_sha256, manifestSha256(load('examples/workflow-manifest.instagram-photo.json')));
  });
  it('example parameters satisfy the example manifest input_schema', () => {
    const m = load('examples/workflow-manifest.instagram-photo.json');
    const s = load('examples/job-submission.json');
    assert.ok(v.validateParameters('example', m.input_schema, s.parameters).ok);
  });
  it('submission fixtures: valid ones validate, invalid ones fail where intended', () => {
    const conformance = load('examples/workflow-manifest.conformance-solid-color.json');
    for (const f of ['valid-solid-color.json', 'slow-solid-color.json']) {
      const s = load(`fixtures/submissions/${f}`);
      assert.ok(v.validate('job-submission', s).ok, f);
      assert.ok(v.validateParameters('conf', conformance.input_schema, s.parameters).ok, f);
    }
    assert.equal(v.validateParameters('conf', conformance.input_schema, load('fixtures/submissions/invalid-parameters.json').parameters).ok, false);
    assert.equal(v.validate('job-submission', load('fixtures/submissions/invalid-contract-version.json')).ok, false);
  });
  it('conformance scenarios C01–C16 are all defined', () => {
    const ids = load('fixtures/conformance-scenarios.json').scenarios.map((s: { id: string }) => s.id);
    assert.deepEqual(ids, Array.from({ length: 16 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`));
  });
  it('openapi.yaml parses and every $ref / externalValue file exists', () => {
    const doc = YAML.parse(readFileSync(join(dir, 'openapi.yaml'), 'utf8'));
    assert.equal(doc.openapi, '3.1.0');
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [k, val] of Object.entries(node)) {
          if ((k === '$ref' || k === 'externalValue') && typeof val === 'string' && val.startsWith('./')) refs.push(val.split('#')[0]!);
          else walk(val);
        }
      }
    };
    walk(doc);
    assert.ok(refs.length > 20);
    for (const r of new Set(refs)) assert.ok(existsSync(resolve(dirname(join(dir, 'openapi.yaml')), r)), r);
  });
});
