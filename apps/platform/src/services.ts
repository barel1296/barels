import type pg from 'pg';
import type { Config } from './config.js';
import { ContractValidator } from './contract/validator.js';
import { createPool } from './db/pool.js';
import { ContentStore } from './modules/content-store.js';
import { LlmGateway } from './modules/llm/gateway.js';
import { EngineClients } from './modules/visual/engines.js';
import { PublishingAdapters } from './modules/publishing.js';

/** Process-wide dependencies shared by the API and the workers. */
export interface Services {
  config: Config;
  /** aios_app: NOBYPASSRLS; every tenant statement runs with app.workspace_id set. */
  appPool: pg.Pool;
  /** aios_worker: cross-workspace background processing. */
  workerPool: pg.Pool;
  validator: ContractValidator;
  store: ContentStore;
  engineClients: EngineClients;
  publishingAdapters: PublishingAdapters;
  /** The one shared local LLM (all influencers). */
  llm: LlmGateway;
}

export function createServices(config: Config, overrides: Partial<Pick<Services, 'publishingAdapters' | 'llm'>> = {}): Services {
  const validator = new ContractValidator(config.contractDir);
  const services: Services = {
    config,
    appPool: createPool(config.databaseUrl, 'golden-api'),
    workerPool: createPool(config.workerDatabaseUrl, 'golden-worker'),
    validator,
    store: new ContentStore(config.mediaRoot),
    engineClients: new EngineClients(config, validator),
    publishingAdapters: overrides.publishingAdapters ?? new PublishingAdapters(),
    llm: overrides.llm ?? new LlmGateway(config.llm),
  };
  return services;
}

export async function closeServices(s: Services): Promise<void> {
  await Promise.allSettled([s.appPool.end(), s.workerPool.end()]);
}
