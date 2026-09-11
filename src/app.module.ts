import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.schema';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // WHY: `parse` (not `safeParse`) so an invalid env throws during module
      // init and aborts boot — the same fail-fast contract main.ts already
      // enforces, reused here instead of a second hand-rolled check.
      validate: (raw) => envSchema.parse(raw),
    }),
    HealthModule,
  ],
})
export class AppModule {}