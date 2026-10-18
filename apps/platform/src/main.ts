import { buildApi } from './api/server.js';
import { loadConfig } from './config.js';
import { closeServices, createServices } from './services.js';
import { Worker } from './worker.js';

/**
 * Process entry point. Roles: `--api`, `--worker`, or both (default) — the
 * modular monolith runs as one process on the workstation.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const runApi = args.has('--api') || !args.has('--worker');
  const runWorker = args.has('--worker') || !args.has('--api');
  const config = loadConfig();
  const svc = createServices(config);
  const worker = runWorker ? new Worker(svc) : null;
  const app = runApi ? buildApi(svc, { logger: true }) : null;

  if (app) await app.listen({ host: config.httpHost, port: config.httpPort });
  worker?.start();
  console.log(`[golden] started (${[runApi && 'api', runWorker && 'worker'].filter(Boolean).join(' + ')})`);

  const shutdown = async (signal: string) => {
    console.log(`[golden] ${signal}: shutting down`);
    await app?.close();
    await worker?.stop();
    await closeServices(svc);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
