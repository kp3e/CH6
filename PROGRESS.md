# Progress

## Day 1

**Deliverable:** Deployable skeleton — app refuses to boot when misconfigured, CI gates every merge.

**Shipped:**
- Repo initialized, `.gitignore` before first commit, pushed to GitHub (public)
- NestJS scaffold, strict tsconfig (incl. `noUncheckedIndexedAccess`)
- `docker-compose` with Postgres on a named volume + healthcheck
- Zod env schema validated in `main.ts` before `NestFactory.create`; same schema reused in `ConfigModule.validate`
- `/health` (liveness, 200) and `/health/ready` (503 unconditionally until the DB ping exists)
- Body size limit (100kb) on the JSON parser
- CI: lint, typecheck, build on PRs. gitleaks secret scanning. Branch protection requiring both.

**Broke / cost time:**
- Node was on v26 (not LTS); nvm wasn't installed and the first install attempt silently didn't run. Moved to Node 24 LTS.
- TS 6 changed the `types` default — `@types/node` was on disk but never loaded, so `process` was undefined. Nest's scaffold generates TS 5-era config. Fixed with an explicit `types` list.
- `baseUrl` deprecated in TS 6; removed.
- Required status check named `git leak` in the ruleset vs `gitleaks` as the actual job name. Blocked merges with no error — just "expected" forever.
- Concurrency group key was too coarse and cancelled the `pull_request` run.

**Carried over:**
- Real DB ping in `/health/ready`
- Remove leftover Jest config/deps from the scaffold (stack is Vitest)
- Billing alarm on whatever cloud provider ends up being used
- Cloud provider decision — deadline day 8

**Decisions:**
- **CommonJS, not ESM.** Nest's DI relies on `emitDecoratorMetadata`, and Prisma's
  generated client is CJS. Going ESM means extensioned imports, test-runner
  resolution issues, and no `__dirname` — a day of work for nothing demoable.
  Exit path if needed: `"module": "node16"` plus `.js` extensions on relative imports.

- **Declined `@nestjs/observe` at scaffold time.** Auto-instrumentation would hand me traces I didn't build. Day 10 is Pino, correlation IDs, and propagating them into background jobs — the point is wiring it by hand. Also not in the locked stack.

- **Hand-written health endpoints, not `@nestjs/terminus`.** Two endpoints is ten lines. Terminus makes the liveness/readiness split look like a config choice, and that split is the actual lesson. Its response envelope is also opinionated and would clash with the error envelope on day 5.

- **Env validated twice, from one schema.** `main.ts` parses before `NestFactory.create` so nothing can boot ahead of it; `ConfigModule.validate` calls the same schema so `ConfigService` serves coerced, typed values. One schema, two consumers, no drift.

- **No `?? 3000` fallback on PORT.** A silent fallback means the process starts, passes liveness, and listens on a port the load balancer isn't routing to — a "successful" deploy where the service is invisible. Failing to boot is louder and easier to diagnose.

- **Repo made public.** Enables free branch protection and secret scanning, and the commit history over 14 days is itself evidence. Cost: any leaked secret is immediately public, so gitleaks matters more now.

**Can I explain it?**
- if db is down, the app can still be alive but db may be down. this is solved by having an error warning for the readiness check so it still checks out as not healthy

- if db url from env is not checked before boot, if the db is actually unavailable, the app will be running but no data can be obtained or generated

- git leak vs gitleaks are different. if the ruleset are git leak but the job is gitleaks, it will keep waiting for a response but never get it.