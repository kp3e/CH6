import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { Env } from '../config/env.schema';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        // WHY: without a timeout, a query against an unreachable database waits
        // on the OS TCP timeout (minutes). The readiness probe would hang instead
        // of answering 503, and the load balancer can't take the instance out.
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  // WHY: fail the deploy at boot if the database is unreachable, not on the first
  // user request. A real query, not $connect(): with a driver adapter, $connect()
  // opens nothing — verified, the app booted and served traffic with Postgres stopped.
  async onModuleInit(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  // WHY: close pool connections on SIGTERM. Otherwise every deploy leaks
  // connections until Postgres hits max_connections and refuses new ones.
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
