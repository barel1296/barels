/**
 *   npm run conformance -- --engine-url http://127.0.0.1:8188/vec/v1 --token "$VEC_ENGINE_TOKEN" [--report out.json]
 */
import { writeFileSync } from 'node:fs';
import { paths } from '../config.js';
import { runConformance } from './runner.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const engineUrl = arg('engine-url');
  const token = arg('token') ?? process.env.VEC_ENGINE_TOKEN;
  if (!engineUrl || !token) throw new Error('usage: --engine-url <…/vec/v1> --token <token> (or VEC_ENGINE_TOKEN)');
  const report = await runConformance({ engineUrl, token, contractDir: process.env.CONTRACT_DIR ?? paths.contractDir });
  console.log(`Visual Engine Contract v1 conformance — ${report.engine_url}`);
  if (report.engine) console.log(`engine: ${report.engine.engine_id} ${report.engine.engine_version} (engine_kind=${report.engine.engine_kind})`);
  for (const r of report.results) console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name.padEnd(30)} ${r.detail}`);
  console.log(`\n${report.results.filter((r) => r.passed).length}/${report.results.length} passed — ${report.passed ? 'CONFORMANT' : 'NOT CONFORMANT'}`);
  console.log(report.note);
  const out = arg('report');
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(2);
});
