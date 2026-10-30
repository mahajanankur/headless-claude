---
paths:
  - "src/**"
  - "config/**"
  - "skills/**"
  - "scripts/**"
  - "test/**"
  - "ops/**"
---

# Backend Rules — headless-claude

- **Stack:** Node.js 20, Express, PostgreSQL (Sequelize, `pg`), node-config (`config` v3), Motifer logging, Jest, Docker. CommonJS.
- **No Redis**, and no other servers or binaries beyond Postgres, Docker and the `claude` CLI.
- **When rules conflict:** app isolation and sandbox safety → data atomicity → API contract → minimal patch → style.
- **Design sources:**
  - `docs/architecture.md` (target design)
  - `docs/decisions.md` (the decision register)
  - `docs/claude-code-behavior.md` (verified CLI behaviour)
  - `docs/roadmap.md` (what is built)

---

## 1. Design

```
Client ─▶ API (src/api/server.js) ─▶ Postgres: jobs (queued)
                                         │  NOTIFY
          Worker (src/worker/index.js) ◀─┘  claim (FOR UPDATE SKIP LOCKED)
              ├─▶ Runner (docker | local | host) ─▶ ccwrap ─▶ claude -p (stream-json)
              ├─▶ job_events (append-only) ─▶ NOTIFY ─▶ API ─▶ SSE + Socket.IO
              └─▶ app_usage_daily ─▶ budget check
```

**Processes**
- **The API and the worker are separate processes.** The API never runs a job. The worker never serves client traffic, only `/health`.
- **Postgres is the only queue and signal bus.** Claiming uses `FOR UPDATE SKIP LOCKED`. Wake-ups and live events use `LISTEN/NOTIFY` through a single shared listener (`notifyHub`). Never add Redis or a message broker.

**API**
- **The API is async.** `POST /api/v1/jobs` returns `202` with `jobId`. An optional `?wait=` of up to 55 s may return `200` with the result.
- **Progress** comes through **SSE** (`GET /api/v1/jobs/:id/stream`), **Socket.IO** (namespace `/jobs`) or polling. All three read the same `job_events` rows.

**Runners**
- **Docker** is the default on EC2.
- **local** is for Mac development only.
- **host** (systemd) is an optional fallback and stays off unless configured.

**Job lifetime**
- **Jobs outlive the worker.** A worker restart detaches. The next worker re-attaches from `job_attempts.stream_offset`.
- **Claude Code facts are verified, not assumed.** Check `docs/claude-code-behavior.md` before relying on any CLI behaviour.

---

## 2. Non-Negotiables

| # | Rule |
|---|---|
| N1 | Minimal patch: change only what was asked. Never rewrite a whole file to change part of it |
| N2 | Never break an API contract (shape, field, status code). Changes are new optional fields or `/api/v2` |
| N3 | Every app-facing query filters on `app_id`. The app comes from `req.context.appId` only, never from the body or query |
| N4 | Multi-step writes run in one transaction. **No external I/O inside a transaction**: no spawn, HTTP, git or file writes |
| N5 | Every route has a validator **and** an auth/scope check |
| N6 | Every tunable comes from node-config via `config.get()`: limits, models, timeouts, slots, thresholds. Nothing hardcoded |
| N7 | A full error is logged once, in the deepest layer |
| N8 | Schema changes go through migrations only. Never `sync()` |
| N9 | New features sit behind a per-app flag, **off by default** |
| N10 | Every job is bounded by a timeout, `--max-turns`, a budget, an output cap and slot/concurrency caps |
| N11 | A sandbox never sees another app's data or home, the gateway's DB credentials or secrets file, or git push credentials |
| N12 | No new npm dependency without approval |
| N13 | Never pass bare `Read`/`Grep`/`Glob`/`Edit`/`Write` in `--allowedTools`. A bare `Read` lets Claude read **any** file (verified). File tools stay limited to the cwd and `--add-dir` dirs |
| N14 | Never trust the `claude` exit code. Classify from the final `result` line: `is_error`, `subtype`, `terminal_reason`, `api_error_status`. SIGINT exits 0, and auth errors report `subtype: success` |

---

## 3. Folder Structure

```
├── config/             node-config: default.json · development.json · test.json · production.json
│                       custom-environment-variables.json · index.js (loader) · paths.js (derived paths)
├── src/
│   ├── api/            server.js · app.js · socket.js
│   │   ├── routes/         index.js (every route, its auth and scope)
│   │   ├── controllers/    *.controller.js
│   │   ├── validators/     *.validator.js (express-validator)
│   │   ├── middlewares/    requestId · authenticate (+ requireScope/requireAdmin/requireFeature) · streamAuth · rateLimit · validate · errorHandler
│   │   └── dtos/           Response envelope + per-resource shapers
│   ├── services/       *.service.js      business rules, transactions, state transitions
│   ├── repositories/   *.repository.js   one per model, all queries
│   ├── db/             models/ (one per table, associations in index.js) · migrations/ · config.js (sequelize-cli)
│   ├── schemas/        JSON schemas (skillManifest.schema.json)
│   ├── worker/         index.js · worker.js (loops, recovery, reaper) · attemptSupervisor.js · argsBuilder.js
│   │   │               workspaceManager.js · streamTail.js · streamParser.js · artifactStore.js · changeDelivery.js · providerHealth.js
│   │   ├── runners/        runnerFactory.js · base.runner.js · docker.runner.js · local.runner.js · host.runner.js
│   │   │                   wrapper/ccwrap.js (runs inside the sandbox; imports nothing from the repo)
│   │   └── git/            repoManager.js · github.js · askpass.sh
│   ├── infra/          notifyHub.js (pg LISTEN/NOTIFY) · advisoryLock.js · secrets.js
│   ├── constants/      jobStatus · eventTypes · errorClasses · scopes · features · skill · provider · delivery · audit · apiErrors
│   └── utils/          logger · redactor · AppError · hash · jsonSchema · requestContext · transaction
│                       backoff · timeWindow · safeFs · encryption · netGuard
├── skills/<name>/      manifest.json · .claude/skills/<name>/SKILL.md
├── scripts/            operational scripts (sync-skills.js, create-app.js, secrets.js)
├── ops/                postgres/ (local init) · host/ (systemd units, runner helper, sudoers, metadata block) · phase0/ (Linux probe)
├── test/               unit/ · integration/ · helpers/ · docker/ · fixtures/{claude,fake-claude,skills}
└── docs/               architecture · decisions · roadmap · configuration · claude-code-behavior
```

Entry points: `src/api/server.js` (API) and `src/worker/index.js` (worker). Pure decision logic lives in services (`schedulingPolicy`, `retryPolicy`, `outcome`, `usage`) so it can be table-tested.

**Dependencies flow downward only:**
- `api → services → repositories → models`.
- `worker → services`. The worker calls services and never repositories.
- `utils`, `constants`, `schemas` and `db` import nothing from `api`, `services`, `repositories` or `worker` (`utils/transaction.js` may import `db/models`).
- `runners`, `git` and `infra` never touch the DB.
- No circular requires.

---

## 4. Layers

`Middleware → Controller → Validator → Service → Repository → Model`

| Layer | Does | Never |
|---|---|---|
| Controller | Reads `req.context`, runs the validator, calls **one** service, responds through the `Response` DTO, `return next(error)` | DB access, business logic |
| Validator | Shape, coercion (`.toInt()`, `.trim()`, `.toBoolean()`), bounds from config, rejects unknown fields, UUID-checks path ids | DB, services |
| Service | Business rules, transactions, state transitions, shapes plain objects for return | SQL, `req`/`res`, Express, returning model instances |
| Repository | All queries, accepts `{ transaction }`, logs the full error then rethrows | Business rules, opening transactions |
| Worker | Claims → calls a service → runs the runner → calls a service | Business rules, DB access |
| Runner | Talks to the sandbox backend (Docker / process / systemd) | DB access |
| Model | Sequelize definition and associations | Logic, hooks with side effects |

---

## 5. Code Style

**Functions**
- Arrow functions and `async/await` only. No callbacks, no `.then()` chains.
- One job per function: at most 50 lines and 4 parameters, otherwise pass an options object. Prefer guard clauses to nesting.
- New parameters get defaults so existing callers keep working.
- Pure helpers with no I/O live in `src/utils/`.

**Naming**

| Thing | Convention | Example |
|---|---|---|
| Files | `camelCase.<role>.js` | `job.service.js`, `docker.runner.js`, `jobs.validator.js` |
| Functions / vars | `camelCase`, verb first | `claimNextJob`, `buildClaudeArgs` |
| Booleans | `is/has/can` | `isTerminal`, `hasStartedActing` |
| Constants | `UPPER_SNAKE` | `JOB_STATUS`, `ERROR_CLASS` |
| Tables / columns | `snake_case`, plural tables | `jobs.app_id`, `job_attempts.stream_offset` |
| Model attributes | `camelCase` (`underscored: true`) | `appId`, `streamOffset` |
| API JSON | `camelCase` | `jobId`, `skillVersion` |
| Feature flags | `<feature>Active` | `sessionsActive`, `changeDeliveryActive` |
| Migrations | `YYYYMMDDHHMMSS-verb-object.js` | `20261028000001-initial-schema.js` |

**Format**
- 4 spaces, single quotes, semicolons, trailing commas, `'use strict';` at the top.
- `const` over `let`, never `var`.
- ESLint + Prettier with `no-console`. Adding them is a one-time approved dev dependency.

**Imports** (blank line between groups): Node built-ins and externals → `config` → models / repositories / services → utils / dtos / AppError → constants + `logger`.

**Comments:** explain why, not what. Every exported function gets JSDoc (`@param`, `@returns`, `@throws`). No commented-out code.

---

## 6. Config & Constants

- **node-config is the only config source.**
  - **Files:** `config/default.json` holds **every** key with a safe default. `development.json`, `test.json` and `production.json` override only what differs.
  - **Loader:** `config/index.js` loads `.env.local` (never in production), sets `NODE_CONFIG_DIR`, and exports the node-config instance.
  - **Usage:** always `const config = require('<relative>/config'); config.get('worker.concurrency')`. Never read `process.env` anywhere else.
- **Environments:**
  - `NODE_ENV=development` is the default and the **only** environment pointing at localhost.
  - Never create `config/local.json` or use `NODE_ENV=local`. node-config loads `local.json` in **every** environment, production included; verified, it made production use the local runner.
- **Env overrides and secrets:**
  - Env-var overrides go only through `config/custom-environment-variables.json` (use `__format` for numbers, booleans and JSON).
  - Secrets (DB URL, Claude OAuth token, manifest secrets, git credentials, webhook and stream-token keys) come only from env vars or the secrets file (`paths.secretsFile`, loaded by `src/infra/secrets.js`), never from committed JSON.
  - Every secret value is registered with the redactor at load. Boot fails fast if a required one is missing.
- **Read once:** read config at module scope, never per request. Derived values (absolute paths, host id, node binary) are computed once in `config/paths.js` (`PATHS`, `HOST`).
- **Logged config** always passes through the redactor.
- **Sections:** `server`, `postgres`, `auth`, `rateLimit`, `pagination`, `job`, `llm`, `runner`, `worker`, `usage`, `stream`, `scheduler`, `paths`, `logging`.
- **Config vs constant:**
  - Config is what ops may change per environment (limits, timeouts, models, thresholds).
  - A constant is code meaning (statuses, event types, error classes, scopes, feature keys). Constants are `Object.freeze`d in `src/constants/`.
- **No magic strings:** write `JOB_STATUS.RUNNING`, never `'running'`.

---

## 7. Auth & App Isolation

An **app** is the tenant unit: one calling application with its API keys, allowed skills, allowed models, budget and run windows.

| Layer | Middleware | Fail |
|---|---|---|
| Identity | `authenticate` sets `req.context = { appId, keyId, scopes, isAdmin, requestId }` | 401 |
| Admin | `requireAdmin` | 403 |
| Scope | `requireScope(SCOPES.JOBS_WRITE)` | 403 |
| Feature | `requireFeature(FEATURES.SESSIONS)` | **404** (hides unreleased features) |

**API keys**
- Stored as SHA-256 hashes, shown once at creation, displayed as prefix + last 4.
- Scoped, expirable and revocable at once. Compare with `crypto.timingSafeEqual`.

**Browser stream tokens** (SSE and Socket.IO)
- HS256 JWT, 10 minutes, claims `{ sub: jobId, app, scope: 'job:stream' }`.
- The secret lives only in the API process.
- The origin is checked against `apps.stream_origins`.

**Declarations:** scopes in `src/constants/scopes.js` and feature keys in `src/constants/features.js`. Never string literals.

**Repository rules**
- App-facing repository methods **require** `appId` and throw if it's missing.
- A job that doesn't exist and a job that belongs to another app both return **404**.
- **Never use `findByPk` on app-facing data**, because it drops the `where`. Use `findOne({ where: { id, appId } })`.
- Worker-internal lookups by id are allowed only in methods named `*Internal` and called only from worker-path services.

---

## 8. Database

**Models**
- One file per table in `src/db/models/`, with associations in `index.js`.
- Settings: `underscored: true`, `timestamps: true`.
- UUID primary keys for anything that appears in a URL.
- Status columns are `STRING` (never a PG `ENUM`), checked against `JOB_STATUS`.
- Timestamps are `TIMESTAMPTZ` in UTC.
- JSONB only for data you never filter on (`input`, `result`, `usage`, `manifest`).
- Large outputs go to files (artifacts), never JSONB.

**Queries**
- Always set `attributes`. Never `SELECT *` on app-facing reads.
- No N+1 queries and no query inside a loop. Use `Promise.all` for independent reads **outside** transactions; inside a transaction, queries run one after another (one connection, no concurrent queries).
- Every `order` is deterministic, with an `id` tiebreak.
- Composite indexes lead with `app_id` for app-facing queries.
- Use `distinct: true` on `findAndCountAll` with a `hasMany`.

**ORM vs raw SQL**
- Use the ORM unless the query needs `SKIP LOCKED` with complex predicates, window functions, CTE/`UNION`, `FILTER`, JSONB operators, `ON CONFLICT`, advisory locks or `LISTEN/NOTIFY`.
- Raw SQL rules: `replacements` only, an `app_id` predicate when app-facing, repository layer only, camelCase aliases, and a comment `// raw because: <construct>`.

**Transactions**

Use `withTransaction` from `src/utils/transaction.js`:

```javascript
const result = await withTransaction('job.finishAttempt', async (transaction) => {
    await jobAttemptRepository.update(attemptId, fields, { transaction });
    await jobRepository.updateIfStatus(jobId, [JOB_STATUS.RUNNING], jobFields, { transaction });
    return { jobId };
});
await notifyHub.publish(CHANNELS.JOB_EVENTS, { jobId });   // side effects AFTER commit
```

- Transactions are opened in services only.
- `{ transaction }` is passed to every repository call inside one.
- Reads that don't need a lock stay outside.
- A single insert or update needs no transaction.
- Never spawn processes, write files, run git or make HTTP calls inside one.

**Migrations**
- Created with `npx sequelize-cli migration:generate` (real timestamp). Each has `up` and `down`.
- **Expand → migrate → contract:** never drop or rename a column that running code reads.
- Named indexes. Big-table indexes use `CONCURRENTLY`.
- Backfills are batched and resumable. No hardcoded ids.
- The model and the migration change together. Run migrations before deploying.
- `npm run db:migrate` targets development; `npm run db:migrate:test` targets the test DB. The test DB is selected with `NODE_ENV=test` (it maps `TEST_DATABASE_URL`), not the `--env` flag.

**Core tables:**
- `apps` (gets a `features` JSONB column for flags)
- `api_keys`
- `skills`
- `sessions`
- `jobs`
- `job_attempts`
- `job_events` (append-only, unique on `(attempt_id, seq)`)
- `artifacts`
- `webhook_deliveries`
- `provider_state`
- `app_usage_daily`
- `audit_logs`

Idempotency is a unique index on `jobs (app_id, idempotency_key)`.

---

## 9. Errors

```javascript
class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details) {
        super(message);
        Object.assign(this, { name: this.constructor.name, statusCode, code, details });
    }
}
// ValidationError 400 · AuthError 401 · ForbiddenError 403 · NotFoundError 404
// ConflictError 409 · QuotaExceededError 429 · UpstreamError 503
```

**Error codes in use:**
- `UNAUTHORIZED`
- `FORBIDDEN_SKILL`, `FORBIDDEN_MODEL`
- `SKILL_NOT_FOUND`, `JOB_NOT_FOUND`
- `INPUT_INVALID`
- `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`
- `QUOTA_EXCEEDED`, `CAPACITY_PAUSED`
- `INTERNAL_ERROR`

**Handling rules**
- Controllers `return next(error)`. Services and repositories **rethrow** and never return `null` for a failure.
- Typed errors pass through untouched. Never flatten one into a generic error.
- DB constraint codes (23505, 23503, 23502) go through `mapDbError` and become typed errors.
- `errorHandler`, the last middleware, returns `AppError` messages as they are and anything else as a generic 500. It never exposes a stack, SQL or table names, and always includes `requestId`.
- Messages are accurate, actionable, 1–2 sentences. 4xx means the request was bad; 5xx means we broke.

**Job-level failures** are not HTTP errors. They live on `job_attempts.error_class` with a value from `src/constants/errorClasses.js`:
- `gateway`, `validation`, `db`
- `provider_auth`, `provider_limit`, `provider_crash`
- `skill_output_invalid`, `timeout`, `budget_exceeded`
- `delivery`, `webhook`

---

## 10. Logging

**Setup and format**
- Put `const logger = getLogger(__filename)` at module scope (`src/utils/logger.js`, Motifer). Never `console.log`.
- Every line passes through the redactor, and carries `requestId`, `appId`, `jobId` and `attemptId` when known.
- Logs are single lines. The error object is the **last argument, in the deepest layer only**. Higher layers log `error.message`.
- Never `JSON.stringify(error)` or `{ error }`. Add context as `JSON.stringify({ ... })`.

**Never log**
- API keys, OAuth tokens, auth headers or secrets.
- Prompts, inputs, Claude output or repo content. Log their length and hash instead.
- Content is logged only when a skill sets `logContent: true`.

**Levels:** `debug` per item, `info` lifecycle, `warn` recoverable or validation, `error` needs attention.

**One terminal line per attempt:** `jobId, status, errorClass, durationMs, numTurns, tokenCount, attempt`.

---

## 11. Job Patterns

### State machine (`src/constants/jobStatus.js`)

```
queued → claimed → provisioning → running → succeeded | failed | timed_out | needs_review
running → waiting_limit → queued               (Max plan limit hit; resumes at reset)
any non-terminal → cancelling → cancelled
```

- **Transitions** go through `assertTransition(from, to)` plus a guarded update (`WHERE status IN (...)`). Zero rows updated throws `ConflictError`.
- **Terminal states are immutable:** `succeeded`, `failed`, `timed_out`, `needs_review`, `cancelled`. Every transition writes a `job_events` row.
- **`failed` vs `needs_review`:** `failed` means it's certain nothing changed outside the workspace. `needs_review` means side effects may exist. Never mark a job `failed` when the outcome is unknown.

### Claim and schedule
- **Atomic claim** with `FOR UPDATE SKIP LOCKED`. App concurrency and session locks are enforced in the claim query.
- **Then a pure policy check** (`schedulingPolicy.service.js`) inside the same transaction:
  - run window (app ∩ skill)
  - `runAfter`, `urgent`
  - quick/long slots
  - global and per-model limit pauses
  - live Max utilization thresholds from `rate_limit_event`
  - daily budget
- **`urgent`** skips only the run window and `runAfter`.
- **Each claim takes a lease** with a heartbeat. The lease owner is the stable host id.

### Retries
- Never blindly re-run a job that has started acting.
- **Ladder:**
  1. No mutating tool has run yet → fresh retry.
  2. Mutating tools ran and the session can be resumed → resume in the same workspace.
  3. Otherwise a fresh retry only if nothing outside the workspace changed, or the skill is `rerunSafe`.
  4. Otherwise `needs_review`.
- **Infra failures** (startup, `provider_auth`) retry with backoff and jitter, and don't count against `maxAutoRetries`.
- **Limit hits** go to `waiting_limit` and don't count either.
- Retries always use the latest skill version, with the input re-checked against it.

### Worker loop
- Per-job try/catch, so one failure never kills the loop. Concurrency is bounded.
- **On SIGTERM:** stop claiming, detach, exit. Running jobs keep going.
- **The reaper cron** handles three things:
  - re-attaches or finalizes jobs with expired leases
  - sweeps orphaned sandboxes and session locks
  - enforces retention
- **Crons:** a wrapped tick that never throws, an `enabled` flag that defaults to off, and a Postgres advisory lock so only one instance runs.

### Runners
- **Always go through `runnerFactory`.** One interface:
  - `provision(spec)`
  - `start(spec) → handle`
  - `streamOutput(handle, fromOffset)`
  - `isAlive(handle)`
  - `cancel(handle)`
  - `destroy(handle)`
- **Handles** are opaque (a container id, unit name or pid with start time), never a raw pid alone.
- **One sandbox per attempt.** It is destroyed when the attempt is finalized, **not** in the worker's `finally`, because jobs must outlive worker restarts. The reaper destroys orphans.
- **Docker runner (default):**
  - non-root, read-only root FS
  - CPU, memory and pids limits
  - no `--privileged`, no Docker socket
  - **bind-mounts only that job's workspace and that app's Claude home**
  - egress denied by default, plus an allow-list (Anthropic and the manifest's hosts). IMDS `169.254.169.254` is always blocked. **Status:** the metadata block ships (`ops/host/block-metadata.sh`); the allow-list proxy is still to build (`runner.egressProxy`, see `docs/roadmap.md`).
- **local runner:** dev only, on macOS. Never selected in production.
- **host runner:** off unless `WORKER_RUNTIME=host`. It needs `ccrunner` and the bubblewrap sandbox to fail closed.

### Building each run (`argsBuilder`, pure)
- **Model and turns:** `--model` must be in the app's `allowedModels`. Always pass `--max-turns`.
- **Fixed flags:**
  - `--output-format stream-json --verbose`
  - `--permission-mode` chosen per skill
  - `--setting-sources user`
  - `--settings <per-attempt read-only file>`
  - `--add-dir <skill dir>` plus the dirs of skills in `uses`
  - `--json-schema` when the manifest has an `outputSchema`
- **Always disabled:** `AskUserQuestion` (nobody can answer it).
- **Env:**
  - `HOME` and `CLAUDE_CONFIG_DIR` = the app's home
  - `CLAUDE_CODE_OAUTH_TOKEN` or the API key, depending on the profile
  - `DISABLE_AUTOUPDATER=1`
  - only the secrets the manifest declares
  - **`ANTHROPIC_API_KEY` is removed** unless the profile is `api-key`
- **Process:** spawn with `stdio[0] = 'ignore'`. Use `spawn(cmd, args)`, never shell interpolation.
- **Inputs** go in as `ws/input.json` and are never pasted into the prompt.
- **The pinned Claude Code version** is checked at boot.

### Output handling
- **Output is untrusted:**
  - size-limit every stream line and artifact
  - parse defensively
  - read files with no-follow (`safeFs`), and only inside the workspace
  - never `eval` it or put it into SQL or shell commands
- **`rate_limit_event`** updates `provider_state` (utilization and reset per window).
- **Limit messages** pause their scope: `global` or `model:<family>`.
- **Repos** are cloned with a separate git dir that Claude never sees. The gateway alone delivers changes (patch, branch, PR), running git with hooks and fsmonitor off and credentials only through `GIT_ASKPASS`.

### Budget
- **Daily tokens per app**, weighted: `input + output + cache_creation + cache_read × CACHE_READ_WEIGHT`.
- **Checked at submit** (429) and again at claim.
- **Checked in flight** on each usage event. Past the **hard cap** the job is cancelled with `errorClass: budget_exceeded`. Past the **soft cap** it only warns.

### Live events
- **SSE:** `id: <event id>`, resume from `Last-Event-ID` (replay from DB, then live from `notifyHub`), a heartbeat every 15 s, unsubscribe on `close`.
- **Socket.IO** uses the same source and the same auth rules.

### Idempotency and kill-switch
- **Idempotency:** the `Idempotency-Key` header on `POST /api/v1/jobs`, enforced by the unique index. The same key with the same body returns the existing job. The same key with a different body is `409 IDEMPOTENCY_CONFLICT`.
- **Kill-switch:** an admin can pause intake (globally or per app) and cancel every running job for an app. Both actions are audited.

---

## 12. API

**Routes** (base path `/api/v1`):

| Route | Purpose |
|---|---|
| `POST /jobs` | Submit a job |
| `GET /jobs` | List jobs |
| `GET /jobs/:id` | Job status |
| `GET /jobs/:id/result` | Job result |
| `GET /jobs/:id/events` | Event list |
| `GET /jobs/:id/stream` (SSE) | Live progress |
| `POST /jobs/:id/cancel` | Cancel |
| `POST /jobs/:id/retry` | Manual retry |
| `POST /jobs/:id/stream-token` | Browser stream token |
| `GET /jobs/:id/artifacts` | List artifacts |
| `GET /artifacts/:id` | Download an artifact |
| `GET /skills`, `GET /skills/:name` | Skill info |
| `/sessions` | Sessions (behind a flag) |
| `/admin/*` | Admin operations |
| `GET /health` | Health (no I/O) |
| `GET /ready` | Readiness (DB) |

**Envelope everywhere:**
- Success: `{ success, message, data, requestId }`
- Error: `{ success: false, message, error: { code, details }, requestId }`

**Lists** are paginated with cursor pagination on `jobs` and `job_events`, capped by config.

**Filters** are explicit validated params, never passed straight into `where`.

**Headers:** `RateLimit-*` on every response, and `Retry-After` on 429 and 503 (for example a budget reset or a limit pause).

**Callers can never set** tools, env, dirs, credential profile, settings or permission mode.

---

## 13. Validation

- **One library:** `express-validator`, which runs before any service. Input and output against a skill's schemas are checked with Ajv (`src/utils/jsonSchema.js`).
- **Message format:** `"Human Name (fieldName) constraint"`. Example: `'Timeout (timeoutSec) must be between 30 and 3600'`.
- **Bounds:** coerce types, take bounds from config, reject unknown fields, UUID-check path ids.
- **Input size:** capped by `MAX_INPUT_BYTES`.

---

## 14. Feature Flags

- **Storage:** the key lives in `apps.features` (JSONB). Absent means off.
- **Registration:** in `src/constants/features.js`.
- **Gating** is on the server (`requireFeature` / `isFeatureEnabled`). Only an admin toggles a flag, and every toggle is audited.
- **Behaviour:** with the flag off, behaviour is exactly the old behaviour. Test both states.
- **Flagged today:**
  - `sessionsActive`
  - `changeDeliveryActive`
  - `webhooksActive`
  - `streamTokensActive`
  - `waitModeActive`
- **Not flagged:** bug fixes and pure refactors.

---

## 15. Security

**HTTP layer**
- helmet, a CORS allow-list, a body size limit
- rate limits per IP, key and app
- parameterized SQL
- `spawn(cmd, args)`, never `exec` with string interpolation

**Outbound**
- An SSRF guard on webhook URLs: a host allow-list per app, private and link-local addresses refused after DNS resolution, no redirects.
- Outbound webhooks are signed (HMAC-SHA256 with a timestamp).

**Data at rest**
- Secrets are encrypted (AES-256-GCM).
- The audit log covers keys, flags, cancel, the kill-switch and admin actions.
- `npm audit` runs in CI, and containers run as non-root.

**What actually protects the system:** **the sandbox boundary, not the prompt, is the security control.**
- File access stays limited to the workspace (N13).
- The skills tree is read-only to Claude.
- A repo's own `.claude/`, `.mcp.json` and hooks never load (`--setting-sources user`).
- Every attempt's settings file is read-only to Claude.

---

## 16. Testing

| Kind | Scope |
|---|---|
| Unit (`npm test`) | Pure utils, state machine, validators, `schedulingPolicy`, `retryPolicy`, `argsBuilder`, `streamParser` against `test/fixtures/claude/*.jsonl` |
| Integration (`npm run test:integration`) | Real Postgres (`cc_gateway_test`) + the **fake claude** binary through the local runner (+ supertest once the API exists) |
| Runner contract | The same suite runs against every runner adapter |
| E2E | Real `claude` CLI, opt-in only. It uses the Max allowance, so print the planned calls first and use `--model haiku` |

**Every feature covers:**
- the happy path
- validation
- a wrong scope
- **app B gets 404 for app A's job**
- the flag off

**A bug fix** starts with a test that fails.

**Integration tests assert the DB host is `127.0.0.1` or `localhost`.** The local Postgres container is shared: touch only `cc_gateway` and `cc_gateway_test`, never other databases such as `mockpro`.

---

## 17. Ops & Deploy

**Health endpoints:** `/health` does no I/O. `/ready` checks the DB with a short timeout, the Claude version and auth state, and the limit pauses.

**Metrics**
- API: latency and errors by route.
- Queue: depth, claim latency, status counts.
- Jobs: duration p95, tokens per app, Max utilization (5-hour / 7-day).
- Infra: provisioning failures, DB pool.

**Build and deploy**
- One image, two commands: `node src/api/server.js` and `node src/worker/index.js`. Non-root. `npm ci --omit=dev`.
- **Deploy order: migrate → API → worker.** Migrations stay backward-compatible with the code already running.

**Shutdown**
- **API:** stop intake → drain → close the DB.
- **Worker:** stop claiming → detach → close the DB. A fatal error logs and exits, and systemd or Docker restarts it.

**Runbooks:**
- queue backlog
- provisioning failing
- Max limit pause
- budget overrun
- leaked key or token
- pool exhausted
- stuck `needs_review`

---

## 18. Templates

**Controller**
```javascript
router.post('/', requireScope(SCOPES.JOBS_WRITE), async (req, res, next) => {
    try {
        const errors = await jobsValidator.submit(req);
        if (!errors.isEmpty()) throw new ValidationError(errors.array()[0].msg, errors.array());
        const result = await jobService.submit(req.body, req.context, { idempotencyKey: req.get(IDEMPOTENCY_HEADER) });
        return res.status(202).json(new Response(true, 'Job queued.', result, req.context.requestId));
    } catch (error) {
        logger.error(`Error submitting job: ${error.message}`);
        return next(error);
    }
});
```

**Repository**
```javascript
/**
 * Fetch one job scoped to the calling app.
 * @param {string} id
 * @param {string} appId
 * @returns {Promise<Object|null>}
 */
const findByIdForApp = async (id, appId) => {
    if (!appId) throw new Error('appId is required');
    try {
        return await Job.findOne({
            where: { id, appId },
            attributes: ['id', 'status', 'skillName', 'model', 'createdAt', 'finishedAt'],
            raw: true,
        });
    } catch (error) {
        logger.error(`Error fetching job: ${error.message}`, error);   // deepest layer
        throw error;
    }
};
```

---

## 19. Review Checklist

**🔴 Blocks merge**
- Data and isolation:
  - missing `app_id`
  - app taken from the body or query
  - `findByPk` on app data
- Secrets and transactions:
  - a secret in code or logs
  - I/O inside a transaction
  - a repository opening a transaction
- Layering and injection:
  - a controller touching the DB
  - SQL or shell interpolation
  - a route without auth or a validator
- Sandbox:
  - an unsafe sandbox (privileged, extra host mounts, open egress, gateway creds or token beyond the profile)
  - bare `Read`/`Write` in `--allowedTools`
  - classifying from the exit code
- Contract and schema:
  - an unbounded job
  - an unguarded status update
  - a breaking API change
  - a model without a migration
  - an unapproved dependency
  - adding Redis or a broker

**🟠 Must fix**
- Flags: no flag, or a flag on by default.
- Queries:
  - an unpaginated list
  - a non-deterministic order
  - `SELECT *`
  - N+1
- Errors and logs:
  - an error logged in more than one layer
  - a typed error flattened
  - internals in a user-facing message
  - logging prompt or output content
- Housekeeping:
  - hardcoded config
  - missing JSDoc
  - a cron that can throw
  - no app-isolation test

**🟡 Should fix**
- a duplicate of an existing util
- raw SQL without a reason comment
- sequential independent awaits
- a function over 50 lines
- naming or import order
