/**
 * Runs the conformance runner (C01–C16) against the contract test adapter.
 * Proves the fixtures, the runner and the mock agree; it says nothing about a
 * real ComfyUI-backed engine (Track A runs the same command against theirs).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { paths } from '../../src/config.js';
import { runConformance } from '../../src/conformance/runner.js';
import { type MockEngine, startMockEngine } from '../../src/mock-engine/engine.js';

describe('conformance runner against the contract test adapter', () => {
  let engine: MockEngine;
  const token = randomBytes(32).toString('base64url');
  before(async () => {
    engine = await startMockEngine({ token, contractDir: paths.contractDir });
  });
  after(async () => {
    await engine?.close();
  });

  it('passes C01–C16 and labels the result as contract-mock only', async () => {
    const report = await runConformance({ engineUrl: engine.url, token, contractDir: paths.contractDir });
    const failed = report.results.filter((r) => !r.passed);
    assert.deepEqual(failed, []);
    assert.equal(report.results.length, 16);
    assert.equal(report.engine?.engine_kind, 'contract_mock');
    assert.match(report.note, /NOT a real visual engine/);
  });

  it('detects a non-conforming engine (wrong token → C02 fails)', async () => {
    const report = await runConformance({ engineUrl: engine.url, token: 'wrong-token', contractDir: paths.contractDir });
    assert.equal(report.passed, false);
    assert.equal(report.results.find((r) => r.id === 'C02')?.passed, false);
  });
});
