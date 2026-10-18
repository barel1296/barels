/**
 * Starts the SIMULATED LLM and ComfyUI servers as one process, so the Windows
 * deployment scripts can be exercised on a machine without a GPU, ComfyUI or
 * a model (CI, a developer laptop). They imitate the HTTP APIs only: nothing
 * they produce is evidence about a real model or renderer, and
 * deploy/windows/integration-test.ps1 labels runs against them as simulated.
 *
 *   npm run simulators -- --llm-port 18091 --comfy-port 18188 [--model sim-chat-model]
 */
import { startComfySimulator } from './comfyui.js';
import { startLlmSimulator } from './llm.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const llm = await startLlmSimulator({ model: arg('model') ?? 'sim-chat-model', port: Number(arg('llm-port') ?? 18091) });
const comfy = await startComfySimulator({ port: Number(arg('comfy-port') ?? 18188) });
console.log(`SIMULATED LLM at ${llm.baseUrl}; SIMULATED ComfyUI at ${comfy.baseUrl}`);

const stop = async () => {
  await Promise.allSettled([llm.close(), comfy.close()]);
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
