import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from './app.module';
import { envSchema } from './config/env.schema';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // WHY: Express already defaults to 100kb; setting it explicitly makes the limit
  // a reviewable decision, so raising it shows up in a diff. JSON bodies here are
  // small metadata — receipt images will use a separate upload path, not this parser.
  app.useBodyParser('json', { limit: '100kb' });
  await app.listen(parsed.data.PORT);
}

// WHY: if boot rejects (port in use, DB unreachable), exit non-zero so the
// platform marks the deploy failed instead of leaving a half-started process.
bootstrap().catch((err: unknown) => {
  // console is allowed here: the structured logger does not exist this early in boot.
  console.error('Failed to start', err);
  process.exit(1);
});