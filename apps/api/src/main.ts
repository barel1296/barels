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
  await app.listen(cfg.API_PORT);
  new Logger('Bootstrap').log(`GROS API listening on :${cfg.API_PORT}`);
}

void bootstrap();
