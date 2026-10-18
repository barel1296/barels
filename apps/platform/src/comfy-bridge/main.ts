/**
 * ComfyUI bridge entry point.
 *
 *   npm run comfy-bridge -- serve                         (configuration from environment, see .env.example)
 *   npm run comfy-bridge -- discover --url http://127.0.0.1:8188 [--url ...]
 *   npm run comfy-bridge -- check-packages --url <comfyui url> --packages <dir>
 *
 * discover and check-packages are read-only.
 */
import { ContractValidator } from '../contract/validator.js';
import { paths } from '../config.js';
import { startBridge } from './bridge.js';
import { checkPackagesAgainstComfy, discoverComfy } from './discover.js';

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'serve';
  const contractDir = process.env.CONTRACT_DIR ?? paths.contractDir;
  if (cmd === 'discover') {
    const urls = args('url');
    if (!urls.length) throw new Error('--url is required (one or more)');
    console.log(JSON.stringify(await discoverComfy(urls), null, 2));
    return;
  }
  if (cmd === 'check-packages') {
    const [url] = args('url');
    const [dir] = args('packages');
    if (!url || !dir) throw new Error('--url and --packages are required');
    const r = await checkPackagesAgainstComfy(url, dir, new ContractValidator(contractDir));
    console.log(JSON.stringify(r, null, 2));
    if (r.rejected.length || r.packages.some((p) => !p.ok)) process.exitCode = 2;
    return;
  }
  if (cmd !== 'serve') throw new Error(`unknown command ${cmd}`);
  const token = required('VEC_ENGINE_TOKEN');
  if (token.length < 32) throw new Error('VEC_ENGINE_TOKEN must be at least 32 characters');
  const bridge = await startBridge({
    token,
    comfyUrl: required('COMFYUI_URL'),
    packagesDir: required('COMFY_BRIDGE_PACKAGES_DIR'),
    dataDir: required('COMFY_BRIDGE_DATA_DIR'),
    contractDir,
    engineId: process.env.COMFY_BRIDGE_ENGINE_ID ?? 'comfyui-bridge',
    maxConcurrentJobs: Number(process.env.COMFY_BRIDGE_MAX_CONCURRENT ?? 1),
    conformanceMode: (process.env.COMFY_BRIDGE_CONFORMANCE ?? 'true') !== 'false',
    inputSubfolder: process.env.COMFY_BRIDGE_INPUT_SUBFOLDER ?? 'golden-refs',
    pollIntervalMs: Number(process.env.COMFY_BRIDGE_POLL_MS ?? 1000),
    host: process.env.COMFY_BRIDGE_HOST ?? '127.0.0.1',
    port: Number(process.env.COMFY_BRIDGE_PORT ?? 8190),
  });
  console.log(`[comfy-bridge] VEC v1 engine listening on ${bridge.url}; ${bridge.packages.size} workflow package(s); ${bridge.packageErrors.length} rejected`);
  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
