/**
 * Runs the contract test adapter as a standalone process (for manual testing,
 * CI and the conformance runner). NOT a visual engine: see engine.ts.
 *
 *   MOCK_ENGINE_TOKEN=... npm run mock-engine -- --port 8188 [--max-concurrent 1] [--no-conformance]
 */
import { paths } from '../config.js';
import { startMockEngine } from './engine.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const token = process.env.MOCK_ENGINE_TOKEN;
  if (!token || token.length < 32) throw new Error('MOCK_ENGINE_TOKEN (>= 32 chars) is required');
  const contractDir = process.env.CONTRACT_DIR ?? paths.contractDir;
  const engine = await startMockEngine({
    token,
    contractDir,
    host: arg('host') ?? '127.0.0.1',
    port: Number(arg('port') ?? 8188),
    maxConcurrentJobs: Number(arg('max-concurrent') ?? 1),
    conformanceMode: !process.argv.includes('--no-conformance'),
  });
  console.log(`[contract-mock] Visual Engine Contract test adapter listening on ${engine.url} (engine_kind=contract_mock; not a real engine)`);
  const stop = async () => {
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
