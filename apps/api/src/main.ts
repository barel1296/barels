import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.set('trust proxy', true);
  app.enableShutdownHooks();

  // Hosted-demo bootstrap: seed the fixed demo tenant once (idempotent).
  // Requires the explicit ALLOW_DEMO_SEED=true opt-in; never runs otherwise.
  if (process.env.ALLOW_DEMO_SEED === 'true') {
    const log = new Logger('DemoSeed');
    try {
      const { seedDemo } = await import('./db/seed');
      await seedDemo();
      log.log('demo seed completed (or already present)');
    } catch (err) {
      log.error(`demo seed failed: ${String(err)}`);
    }
  }

  await app.listen(cfg.API_PORT);
  new Logger('Bootstrap').log(`GROS API listening on :${cfg.API_PORT}`);
}

void bootstrap();
