import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { z } from 'zod';
import { AppModule } from './app.module';
import { envSchema } from './config/env.schema';

async function bootstrap() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule);
  // WHY: cap request body size before any route/DTO sees it. Nest's default
  // body parser has no limit — an attacker (or a buggy client) can send an
  // arbitrarily large payload and the process buffers the whole thing into
  // memory before validation ever runs, which is a cheap way to OOM a server.
  app.use(json({ limit: '100kb' }));
  await app.listen(parsed.data.PORT);
  let test: number = "number"
}
bootstrap();