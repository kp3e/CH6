import { NestFactory } from '@nestjs/core';
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
  await app.listen(parsed.data.PORT);
}
bootstrap();