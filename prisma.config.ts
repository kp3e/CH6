import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// WHY: Prisma 7 no longer reads .env on its own. Node 24 can load it natively,
// so no dotenv dependency. Guarded because CI has no .env file — `prisma generate`
// doesn't need a database URL, only migrate does.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
