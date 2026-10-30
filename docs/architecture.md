# Architecture

This document describes the design as implemented. [roadmap.md](roadmap.md) lists what comes next. [decisions.md](decisions.md) records why each choice was made. Verified Claude Code behaviour is in [claude-code-behavior.md](claude-code-behavior.md).

## 1. Goals

1. **One HTTP call** submits a job. Results come back by polling, by webhook, through SSE or Socket.IO, or in the same call via an optional short `?wait=`.
2. **Jobs survive** client disconnects, worker restarts and host reboots. There are no lost results and no silent double execution.
3. **Every job is bounded and observable:** state, attempts, duration, token usage, errors.
4. **Usage stays fair** between apps (daily token budgets, slots, run windows) and stays within the Claude plan's limits.
5. **A job reaches only what its skill grants.** A repo or a job can't change gateway configuration, or persist anything into later jobs.

**Non-goals:**
- A chat UI.
- Multi-tenant SaaS.
- A general workflow engine. Multi-step work is a skill that calls other skills inside one run.

## 2. Components

```
Client ─HTTP / SSE / Socket.IO─▶ API process
                                    │  validate · auth · enqueue · read · stream
                                    ▼
                                 PostgreSQL ◀── LISTEN/NOTIFY ──┐
                                    ▲                            │
                                    │ claim · events · results   │
                                 Worker process
                                    │ runnerFactory → handle
                                    ▼
             docker:  one container per attempt (default)
             local:   detached process (macOS development)
             host:    systemd transient unit as `ccrunner` + bubblewrap (optional)
                                    ▼
                                 ccwrap ─▶ claude -p … --output-format stream-json
                                    └─ run/stream.jsonl · run/exit.json · control/cancel
```

| Component | Responsibility |
|---|---|
| **API** | Authentication (hashed, scoped API keys; job-scoped stream tokens for browsers), validation, enqueue, reads, cancel/retry, SSE and Socket.IO. Never runs a job |
| **Worker** | Claims jobs, enforces the scheduling policy, prepares workspaces, starts runners, tails output, finalizes attempts, delivers changes and webhooks, recovers after restarts |
| **Runner** | One interface (`provision · start · streamOutput · isAlive · cancel · destroy`) over Docker, a local process, or a systemd unit. Never touches the DB |
| **ccwrap** | A tiny wrapper inside the sandbox. It starts `claude`, appends stdout to `run/stream.jsonl`, writes `run/exit.json` atomically, and turns `control/cancel` into SIGINT, then SIGTERM, then SIGKILL. It is what lets jobs outlive the worker |
| **PostgreSQL** | The queue of record, state, events, usage and audit. `LISTEN/NOTIFY` wakes workers and feeds live streams |

## 3. Skills

A skill is a folder in the skills directory:

```
skills/<name>/
├── manifest.json
└── .claude/skills/<name>/SKILL.md
```

The worker passes the folder with `--add-dir` (for its scripts and references), injects the `SKILL.md` body as system instructions, and sends the manifest `prompt` as the user message. Slash commands are disabled, so no bundled Claude Code command or skill can run.

**Manifest fields** (validated by [`src/schemas/skillManifest.schema.json`](../src/schemas/skillManifest.schema.json)):

| Field | Meaning |
|---|---|
| `name`, `version`, `description` | Identity. `name` must match the folder |
| `class` | `quick` or `long`. Long jobs are limited to `worker.longJobSlots` |
| `defaultModel`, `timeoutSec`, `maxTurns`, `estimatedSec` | Execution bounds |
| `inputSchema`, `outputSchema` | Contracts. The output is enforced with `--json-schema` |
| `prompt`, `appendSystemPrompt` | What starts the run |
| `allowedTools`, `disallowedTools` | Extra pre-approved tools. **Bare file tools (`Read`, `Write`, …) are rejected**, because file access is already limited to the workspace |
| `env` | `secret:<name>` references, injected only into this skill's runs |
| `uses`, `mcpServers`, `network.allowedHosts` | Dependencies and egress |
| `repo`, `changes` | Clone a repo per job. `none \| patch \| branch \| pr` says how the gateway (never Claude) delivers changes |
| `rerunSafe`, `keepWorkspaceOnRetry` | Retry semantics |
| `runWindows` | Allowed start times (IANA time zone, may cross midnight) |
| `logContent` | Opt in to logging prompts and output (off by default) |

`npm run skills:sync` validates every folder. An invalid skill is stored disabled with the reason, and a skill whose folder was removed is disabled. A retry runs the **current** skill version, and the input is re-checked against it.

## 4. Job lifecycle

```
queued → claimed → provisioning → running → succeeded | failed | timed_out | needs_review
running → waiting_limit → queued                (plan limit hit; resumes at reset)
any non-terminal → cancelling → cancelled
```

- **Transitions** are declared in [`src/constants/jobStatus.js`](../src/constants/jobStatus.js) and applied with guarded updates (`WHERE status IN …`). Terminal states are immutable.
- **`failed` vs `needs_review`:** `failed` means it's certain nothing changed outside the workspace. `needs_review` means side effects are possible.

### Submit
1. Authenticate the API key, then check its scopes.
2. Check the skill is enabled and allowed for the app.
3. Check the model is in the app's `allowedModels`.
4. Validate the input against `inputSchema` (size-capped).
5. Check the budget (429 if exhausted).
6. Check the `Idempotency-Key`: the same key and body returns the existing job; the same key with a different body gives 409.
7. Insert the job as `queued`, then `NOTIFY`.

### Claim
1. **SQL stage:** select queued jobs with `run_after ≤ now`, excluding locked sessions and apps at their concurrency cap, `FOR UPDATE SKIP LOCKED`.
2. **Policy stage**, a pure function in the same transaction. A job may start only if all of these hold:
   - its run window is open, or the job is `urgent`
   - no global pause is active, and no pause on its model
   - plan utilization is below the threshold for its class
   - its app has budget left
   - a slot of the right class is free
3. **Lease:** the claimed job gets a lease (60 s, heartbeat every 20 s) owned by a stable host id.

### Run
1. **Workspace:** create the attempt directories:
   - `ws/` is Claude's cwd, holding `input.json`, `repo/` and `out/`
   - `run/` holds the stream and exit files
   - `control/` holds the cancel file
   - `meta/` holds settings that are read-only to Claude
   - For repo skills, clone with a **separate git dir** that Claude never sees.
2. **Arguments** are built by a pure function:
   - `--model`, `--max-turns`, `--output-format stream-json --verbose`
   - `--tools`: an explicit allow-list (`Read`, edit tools for editing skills, `StructuredOutput`, granted families), plus `--disable-slash-commands`. The gateway injects `SKILL.md` as system instructions
   - `--permission-mode`: `dontAsk` for read-only skills, `acceptEdits` for skills that edit files (`edits` or `changes ≠ none`)
   - `--setting-sources user`, `--settings <attempt file>`, `--add-dir <skill>`
   - `--json-schema`
   - `--session-id` for a new conversation, or `--resume` for a crash-resume (with a "continue where you left off" prompt) or the next job in a session (with the skill's own prompt)
   - `AskUserQuestion` is always disallowed.
3. **Environment:**
   - `HOME` and `CLAUDE_CONFIG_DIR` set to the app's own Claude home
   - the credential for the skill's profile
   - `DISABLE_AUTOUPDATER=1`
   - only the declared secrets
4. **Tail** `run/stream.jsonl` from `stream_offset`. Each line becomes a `job_events` row, unique on `(job, attempt, seq)`, so replays after a re-attach are ignored.
   - The first **mutating** tool use (`Bash`, `Write`, `Edit`, MCP) sets `started_acting`. `Read`/`Grep`/`Glob` don't count.
   - `rate_limit_event` updates plan utilization.
   - Usage updates the live budget. Passing the hard cap cancels the job with `budget_exceeded`.
5. **Finalize:** classify the outcome from the final `result` event, never from the exit code. Validate `structured_output` and collect artifacts without following symlinks.
   - In one transaction: the result, the attempt, the terminal state, usage, releasing the session lock, and queueing the webhook.
   - After commit: `NOTIFY`, change delivery, and destroying the sandbox.
   - When delivery will follow, the job is marked `delivery: pending` in the same transaction, so clients never see `succeeded` with an unknown delivery state. The reaper completes deliveries left stranded by a crash.

### Failures and recovery

| Situation | Behaviour |
|---|---|
| Startup, clone or auth failure before any tool ran | Retry with backoff and jitter. It doesn't count against `maxAutoRetries`, but it's bounded (`maxAutoRetries × 3 + 3` attempts in total) |
| Plan limit hit | Pause that scope (`global` or `model:<family>`) until the reset. The job goes to `waiting_limit` |
| Crash, timeout or interrupt after acting | Retry ladder: **resume** the same session in the same workspace. Otherwise a **fresh** attempt, only if nothing outside the workspace changed or the skill is `rerunSafe`. Otherwise `needs_review` |
| Invalid structured output | `failed`, or `needs_review` if it acted. The raw output is kept as an artifact |
| Worker restart or deploy | Stop claiming, detach, exit. The next worker re-attaches from `stream_offset` |
| Host reboot | `exit.json` exists → finalize. A `result` line exists → finalize. Neither → retry ladder |
| DB down while finalizing | `result.json` in the attempt dir is the source of truth. The finish is retried |
| Cancel | Queued: cancelled at once. Running: `cancelling` → cancel file → signals → `cancelled`, flagged `possiblyPartial` if it acted. Already finished: 409 |

## 5. Isolation and security

- **Docker runner (default):**
  - non-root, read-only root FS
  - CPU, memory and pids limits
  - no privilege and no Docker socket
  - only the attempt workspace and the app's Claude home are mounted
  - egress denied except to Anthropic and the manifest's hosts. Cloud metadata (`169.254.169.254`) is always blocked.
- **File tools stay inside the cwd and `--add-dir` directories.** The gateway never passes bare `Read`/`Write` allow rules.
- **Repo config never loads:** a repository's `.claude/`, `.mcp.json` and hooks are excluded by `--setting-sources user`.
- **Secrets:**
  - They come only from the environment or the secrets file and are registered with the redactor.
  - Git push credentials stay in the gateway process (`GIT_ASKPASS`), never in the sandbox.
- **Logging and tracing:** prompts, inputs and outputs are never logged, or sent to the optional LangFuse tracing, unless a skill opts in. Logs carry ids, states, tool names, durations and token counts.

Details and reporting: [SECURITY.md](../SECURITY.md).

## 6. Data model

| Table | Purpose |
|---|---|
| `apps` | Calling applications: allowed skills and models, feature flags, budget, run windows, intake pause, webhook and stream settings |
| `api_keys` | Hashed, scoped, expirable, revocable keys per app |
| `skills` | Registered skill versions, manifests, checksums, enabled state |
| `sessions` | Named or implicit Claude sessions with a lock and expiry |
| `jobs` | One row per request: status, input, lease, result, delivery |
| `job_attempts` | One row per run: runtime handle, stream offset, acted flags, usage, outcome |
| `job_events` | Append-only progress and audit stream |
| `artifacts` | Files produced by a job |
| `webhook_deliveries` | Outbound notification state |
| `provider_state` | Claude version, auth state, plan utilization, limit pauses |
| `app_usage_daily` | Weighted token totals per app per day |
| `audit_logs` | Key, flag, cancel, kill-switch and admin actions |

The schema is in [`src/db/migrations`](../src/db/migrations). Every app-facing table carries `app_id`, and app-facing indexes lead with it.

## 7. API

The base path is `/api/v1`. The full reference is in [api.md](api.md).

**Envelope:**
- Success: `{ success, message, data, requestId }`
- Error: `{ success: false, message, error: { code, details }, requestId }`

| Route | Purpose |
|---|---|
| `POST /jobs` | Submit. `202`, or `200` with `?wait=` when done in time |
| `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/result` | Read |
| `GET /jobs/:id/events`, `GET /jobs/:id/stream` (SSE) | Progress |
| `POST /jobs/:id/cancel`, `POST /jobs/:id/retry` | Control |
| `POST /jobs/:id/stream-token` | Browser stream token |
| `GET /jobs/:id/artifacts`, `GET /artifacts/:id` | Outputs |
| `GET /skills`, `GET /skills/:name` | Discovery |
| `GET /health`, `GET /ready` | Operations |
