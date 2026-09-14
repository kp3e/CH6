# Split — Build Plan

Expense splitter. 14 days, ~3.5h/day, ~50 hours total.
Backend ~35h, iOS client ~12h, buffer ~3h.

Read this alongside `CLAUDE.md`. That file governs *how* you work. This one is *what* you build and *why*.

---

## Part 1 — The data model

Nine tables. Every one of them earns its place; if you can't say why a table exists, you can't defend the design.

### Identity

```
User
  id            uuid pk
  email         citext unique not null
  passwordHash  text not null
  displayName   text not null
  createdAt     timestamptz not null default now()

RefreshToken
  id            uuid pk
  userId        uuid fk -> User on delete cascade
  tokenHash     text not null          -- hash, never the token
  expiresAt     timestamptz not null
  revokedAt     timestamptz
  createdAt     timestamptz not null
```

**Why `citext` for email:** `Alice@x.com` and `alice@x.com` are the same person. If you use plain `text` with a unique index, you get two accounts and a support ticket. The alternative is lowercasing in application code, which works until one code path forgets.

**Why hash the refresh token:** your database is the thing most likely to leak. A leaked refresh token hash is useless; a leaked refresh token is an account takeover. Same reasoning as password hashing, and most tutorials skip it.

**Why a table rather than stateless JWTs for refresh:** you need revocation. "Log out all devices" and "this account was compromised" are impossible with pure stateless tokens. Access tokens stay stateless and short-lived (15 min); refresh tokens are stateful and long-lived (30 days). That split is the industry default and you should be able to explain it.

**Be aware of:** refresh token rotation. Each use issues a new refresh token and revokes the old one. If a revoked token is presented again, that means someone replayed a stolen token — revoke the entire family. This is called reuse detection. Implement it on day 3; it's twenty lines and it's a genuinely strong interview answer.

### Tenancy

```
Workspace
  id              uuid pk
  name            text not null
  defaultCurrency char(3) not null       -- ISO 4217
  createdAt       timestamptz not null

WorkspaceMember
  workspaceId  uuid fk -> Workspace on delete cascade
  userId       uuid fk -> User on delete restrict
  role         enum('owner','member') not null
  joinedAt     timestamptz not null
  primary key (workspaceId, userId)

Invitation
  id           uuid pk
  workspaceId  uuid fk -> Workspace on delete cascade
  email        citext not null
  tokenHash    text not null
  role         enum('owner','member') not null
  expiresAt    timestamptz not null
  acceptedAt   timestamptz
  unique (workspaceId, email) where acceptedAt is null
```

**Why "workspace" and not "group":** identical work now, and it's the shape every B2B product has. Later you can attach billing, settings, audit logs, API keys, and webhooks to a workspace without redesigning. Naming is cheap; renaming is not.

**Why the composite primary key:** it makes "a user is in a workspace twice" impossible at the database level rather than a rule you hope the application remembers.

**Why `on delete restrict` on the member's userId:** you cannot delete a user who has financial history. Their name appears in other people's ledgers. Real systems soft-delete or anonymize; they don't cascade away someone's debts.

**Be aware of:** the partial unique index on `Invitation` allows re-inviting someone after they've accepted and left, while blocking two open invites to the same address. Partial indexes are underused and worth knowing.

### The core

```
Expense
  id             uuid pk
  workspaceId    uuid fk -> Workspace on delete cascade
  description    text not null
  amountMinor    bigint not null check (amountMinor > 0)
  currency       char(3) not null
  paidByUserId   uuid fk -> User
  occurredAt     timestamptz not null
  createdByUserId uuid fk -> User
  receiptId      uuid fk -> Receipt
  version        int not null default 1
  createdAt      timestamptz not null
  deletedAt      timestamptz

ExpenseSplit
  id           uuid pk
  expenseId    uuid fk -> Expense on delete cascade
  userId       uuid fk -> User
  shareMinor   bigint not null check (shareMinor >= 0)
  unique (expenseId, userId)
```

**Why `amountMinor` as bigint:** 1050 means 10.50. Floats cannot represent 0.10 exactly, so `0.1 + 0.2 !== 0.3`, and in an app about money that becomes a support ticket you cannot explain. Integers in the smallest unit are what every payment system does. `bigint` rather than `int` because IDR has no minor unit and the numbers get large fast — 10,000,000 IDR is 10000000, and a 32-bit int caps around 2.1 billion.

**Why store currency per expense, not just per workspace:** a trip has expenses in IDR and a flight booked in USD. Storing the currency next to every amount is the only thing that keeps conversion honest later. An amount without a currency is not a quantity.

**Be aware of — the rounding problem.** 10.00 split between 3 people is 3.33, 3.33, 3.33, which sums to 9.99. One cent has vanished. You must decide who absorbs the remainder and enforce that `sum(shareMinor) == amountMinor` exactly. Common approach: distribute the remainder one minor unit at a time, deterministically ordered, so the same input always produces the same output. Add a check for this in your service and a test that runs every split count from 2 to 10. This is the single most common bug in expense apps.

**Why `version`:** optimistic locking. Two people editing the same expense — last write silently wins and someone's change disappears. Client sends the version it read, server rejects on mismatch with `409 Conflict`. Cheap now, impossible to retrofit without a migration and a client update.

**Why `deletedAt` (soft delete):** deleting an expense changes everyone's balance retroactively. You want to be able to answer "why did my balance change last Tuesday," which means the row must survive. Also: never let a hard delete remove financial history.

### The ledger

```
LedgerEntry                        -- append only, never updated, never deleted
  id                uuid pk
  workspaceId       uuid fk -> Workspace
  userId            uuid fk -> User          -- whose balance moves
  counterpartyId    uuid fk -> User          -- relative to whom
  amountMinor       bigint not null          -- signed: + owed to them, - they owe
  currency          char(3) not null
  sourceType        enum('expense','expense_reversal','settlement')
  sourceId          uuid not null
  createdAt         timestamptz not null
  unique (sourceType, sourceId, userId, counterpartyId)
```

**Why a ledger instead of a `balance` column:** three reasons, and this is the design decision I'd most want you to be able to defend.

1. **Auditability.** "Why do I owe Sarah 180k?" is the product's core question. A mutable balance column can only answer "because it says 180k." A ledger can list every entry that produced it.
2. **Idempotency.** The unique constraint means writing the same source twice is a database error, not a silent double-count. If a retry or a duplicated job replays an event, the second write bounces. With a mutable column, `balance += x` twice is undetectable and unrecoverable.
3. **Concurrency.** Appends don't contend. Two people adding expenses write different rows. `UPDATE balance SET balance = balance + x` on the same row serializes and, done naively with a read-then-write, loses updates.

**Be aware of:** the tradeoff is read cost. Computing a balance means aggregating every entry, which is fine at thousands of rows and not fine at millions. The standard fix is a periodic snapshot: store a checkpoint balance at a point in time and aggregate only entries after it. Know that this is the answer; don't build it now.

**Corrections are new entries, not edits.** Editing an expense writes reversal entries plus new ones. Never update a ledger row. This is how accounting has worked for six hundred years and how Stripe works today.

### Settlements and payments

```
Settlement
  id              uuid pk
  workspaceId     uuid fk -> Workspace
  fromUserId      uuid fk -> User
  toUserId        uuid fk -> User
  amountMinor     bigint not null check (amountMinor > 0)
  currency        char(3) not null
  status          enum('pending','confirmed','failed','expired')
  providerRef     text
  createdAt       timestamptz not null
  confirmedAt     timestamptz
  expiresAt       timestamptz not null
  check (fromUserId <> toUserId)

IdempotencyKey
  key            text pk
  userId         uuid fk -> User
  endpoint       text not null
  requestHash    text not null
  status         enum('in_progress','completed')
  responseStatus int
  responseBody   jsonb
  createdAt      timestamptz not null
  unique (key, userId)
```

**Why a status machine rather than a boolean:** payment is not instantaneous. The transitions are `pending → confirmed`, `pending → failed`, `pending → expired`. Ledger entries are written **only** on `confirmed`. Modelling this explicitly is what stops you from marking a debt paid before money moved.

**Why `requestHash` on the idempotency key:** the same key with a *different* body is a client bug, and the correct response is `422`, not silently returning the old result. Stripe does exactly this. Most implementations miss it.

**Why the `in_progress` status:** two identical requests arriving simultaneously. The first inserts the key and starts work; the second hits the unique constraint, sees `in_progress`, and returns `409` telling the client to retry. Without this, both proceed and you double-settle.

**Be aware of — the hardest bug in this app.** The expiry job and the payment confirmation can fire at the same moment. The job marks it `expired`; the webhook marks it `confirmed`. Money moved but your system says it didn't, or vice versa. Fix: make every transition a conditional update — `UPDATE ... SET status='confirmed' WHERE id=$1 AND status='pending'` — and check the affected row count. Zero rows means someone beat you to it, and you handle that explicitly. This pattern is called a compare-and-swap and it appears everywhere in distributed systems.

### Async infrastructure

```
Receipt
  id                 uuid pk
  workspaceId        uuid fk -> Workspace
  uploadedByUserId   uuid fk -> User
  storageKey         text not null
  status             enum('pending','processing','done','failed')
  extractedTotalMinor bigint
  extractedMerchant  text
  attempts           int not null default 0
  createdAt          timestamptz not null

OutboxEvent
  id             uuid pk
  aggregateType  text not null
  aggregateId    uuid not null
  eventType      text not null
  payload        jsonb not null
  createdAt      timestamptz not null
  processedAt    timestamptz
```

**Why an outbox:** you want to write a settlement *and* enqueue a job. Those are two systems (Postgres and Redis), and there's no transaction spanning both. If the database commits and the enqueue fails, the job is lost forever. The outbox trick: write the event to a table **inside the same transaction** as the business data, then a separate poller reads unprocessed rows and enqueues them. Now the write is atomic and the job is guaranteed to eventually fire. This is the transactional outbox pattern and it's a strong thing to know.

**Be aware of:** this gives you *at-least-once* delivery, not exactly-once. The poller can crash after enqueuing but before marking processed, and the job runs twice. Therefore **every consumer must be idempotent.** Exactly-once delivery does not exist in distributed systems; exactly-once *effects* via idempotent consumers do. That distinction is a common senior interview question.

---

## Part 2 — The 14 days

Each day: what you build, the concept it teaches, and what breaks in production without it.

### Week 1 — the service

**Day 1 · Foundation** *(no iOS)*
Nest scaffold, `docker-compose` with Postgres, strict tsconfig, env config validated at boot with Zod, `/health` and `/health/ready`, GitHub Actions running lint and typecheck on PRs.
**Concept:** fail-fast configuration and the deployable skeleton.
**Without it:** the app boots with a missing env var and dies at 3am on the first request that needs it, instead of refusing to start during deploy. Liveness vs readiness matters because a load balancer must know the difference between "process alive" and "can serve traffic."

**Day 2 · Users and passwords**
Prisma schema for User, first migration, register and login, argon2id hashing, access JWT.
**Concept:** credential storage, migrations as versioned schema history.
**Without it:** bcrypt is acceptable, argon2id is current best practice, plain SHA-256 is a breach. Understand why password hashing must be *slow* and why a salt is per-user.
**Be aware of:** return an identical response for "wrong password" and "no such user," or you've built a user-enumeration oracle. Also rate-limit login from day one.

**Day 3 · Sessions and guards**
Refresh tokens with rotation and reuse detection, auth guard, `@CurrentUser()` decorator, Vitest + supertest e2e harness.
**Concept:** authentication as a lifecycle, not a login endpoint.
**Be aware of:** get the e2e harness right today — a test database, truncated between tests. If testing is painful you'll stop doing it by day 6, and that's how this project fails.

**Day 4 · Workspaces and authorization** *(the most important day)*
Workspaces, members, roles, and a guard that verifies the caller is a member of the workspace owning the resource.
**Concept:** authentication is *who you are*; authorization is *what you may touch*. They are different and the second one is where breaches happen.
**Without it:** you have an IDOR — change the ID in the URL and read someone else's data. This is consistently in the OWASP top 10 and it's the vulnerability most likely to appear in a junior's portfolio project.
**Be aware of:** enforce it in one place (a guard or an interceptor), not in each controller. A rule repeated in forty places is a rule that will be forgotten in one of them.

**Day 5 · API surface**
Invitations, cursor pagination on list endpoints, one exception filter with a consistent error envelope, OpenAPI from decorators.
**Concept:** an API is a contract.
**Be aware of:** cursor pagination over offset. Offset pagination skips and duplicates rows when the underlying data changes between pages, and gets slow at depth because the database still walks the skipped rows.

**Day 6 · Expenses** *(+2h iOS: auth and workspace list screens)*
Create and list expenses with splits, equal and exact modes, in a transaction. The rounding algorithm and its tests.
**Concept:** money arithmetic, and transactional writes across parent and children.
**Without it:** an expense whose splits don't sum to the total corrupts every balance derived from it, silently, forever.

**Day 7 · Balances and simplification** *(+2h iOS: expense feed)*
Ledger entries written on expense creation. Balance aggregation. Debt simplification.
**Concept:** derived state, and the first algorithm in the project that's actually interesting.
**Be aware of:** simplification is a min-cost-flow problem in general, but a greedy approach — repeatedly match the largest creditor with the largest debtor — is near-optimal, obvious to explain, and fine here. Know that the greedy version isn't provably minimal; that honesty plays well in interviews.

### Week 2 — production

**Day 8 · Settlements and idempotency**
Settlement state machine, `Idempotency-Key` middleware, fake payment provider with success, failure, and hang modes, expiry job, compare-and-swap transitions.
**Concept:** exactly the reason payment APIs look the way they do.
**Without it:** a double-tapped button pays someone twice and your ledger is wrong in a way users will notice immediately.

**Day 9 · Files and async** *(+2h iOS: camera and upload)*
S3 presigned upload, Receipt record, BullMQ worker, outbox poller. OCR can be a stub that returns a fixed total — the pipeline is the lesson, not the OCR.
**Concept:** never proxy file uploads through your API; hand the client a presigned URL and let it talk to S3 directly.
**Be aware of:** cap the presigned URL's lifetime and content-length. An unbounded presigned URL is a free file host for whoever finds it.
**Be aware of:** every job needs a retry policy with exponential backoff and a dead letter queue. A job that retries forever at full speed will take down whatever it's calling.

**Day 10 · Currency and observability**
External FX API, structured JSON logging with Pino, correlation IDs propagated from request through to job, request-timing interceptor.
**Concept:** you cannot debug what you cannot trace.
**Be aware of:** never call a third-party API without a timeout. The default in most HTTP clients is no timeout, which means one slow provider can exhaust your connection pool and take down endpoints that have nothing to do with currency. Add a timeout, a retry, and a stale-cache fallback.

**Day 11 · Ship it**
Multi-stage Dockerfile, non-root user, CI running migrations and deploying to AWS on merge to main.
**Concept:** a deploy is a commit, not a console session.
**Be aware of:** migrations run *before* the new code starts, which means every migration must be backward compatible with the currently running version — during a deploy both versions are live. Dropping a column in the same release that stops using it will break requests mid-deploy. The fix is the expand/contract pattern, over two releases.

**Day 12 · Operator view** *(+3h iOS)*
Metrics endpoints, the iOS operator tab, settle-up screen.
**Concept:** this is your demo, and the thing that makes the invisible work visible.

**Day 13 · Hardening** *(buffer)*
Rate limiting, security headers, the load script against settlement, fix what it finds.

**Day 14 · Defend it**
README with an architecture diagram and a written decisions log. Rehearse the demo. Write out your answers to the questions below.

---

## Part 3 — Be able to answer these

If you can answer all of these from your own code, you are ready to interview.

1. Why integers for money?
2. Why a ledger instead of a balance column?
3. What happens if the settle button is tapped twice?
4. How do you stop me reading another workspace's expenses?
5. Why are refresh tokens in the database when access tokens aren't?
6. What happens if the receipt worker crashes mid-job?
7. Why an outbox instead of enqueuing directly?
8. What breaks if two people edit the same expense?
9. How does your deploy avoid downtime, and what would break it?
10. What's the first thing that falls over at 100x traffic?

Number 10 is the one to be honest about. "The balance aggregation, because it scans the whole ledger. I'd add snapshots" is a much better answer than pretending nothing would.

---

## Cut list

If you fall behind, cut in this order. Do not cut from the top.

1. Currency conversion (day 10)
2. Debt simplification (show raw pairwise balances)
3. Receipt OCR (keep upload, drop the worker)
4. Invitations (add members by email directly)

Never cut: authorization, the ledger, idempotency, tests, the deploy pipeline. Those are the project.
