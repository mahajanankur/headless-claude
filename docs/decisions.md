# Design decisions

Each entry records the decision, why it was made, and what was rejected. Change a decision by editing its entry in the same pull request as the code.

## Execution

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | **Run the `claude` CLI** (`-p --output-format stream-json --verbose`) as a child process per attempt | It works with both subscription and API-key auth, and gives the full event stream | The Agent SDK: its docs assume API keys |
| D2 | **ccwrap** wraps every run. It writes `run/stream.jsonl` and an atomic `run/exit.json`, and watches `control/cancel` | Jobs must outlive worker restarts. The worker re-attaches from a byte offset | Piping stdout to the worker, which loses the job on restart |
| D3 | **Runner is configurable:** `docker` is the default, `local` is for macOS dev, `host` (systemd + `ccrunner` + bubblewrap) is an optional fallback. One interface with opaque handles | Containers give the strongest boundary. Local dev needs no Docker-in-Docker | A shared process with no sandbox; one Linux user per app |
| D4 | **Pin the Claude Code version** and set `DISABLE_AUTOUPDATER=1` | Stream format and flags change between versions | Auto-update in production |
| D5 | **Classify outcomes from the final `result` event,** never the exit code | SIGINT exits `0`; auth failures report `subtype: success` ([details](claude-code-behavior.md)) | Exit-code mapping |
| D6 | **Never pass bare file tools** in `--allowedTools` | A bare `Read` lets Claude read any file on the host. Without it, access is limited to the cwd and `--add-dir` directories | Path-pattern allow rules |
| D7 | **Use `--setting-sources user`** plus a per-attempt read-only `--settings` file. Each app gets its own `HOME`/`CLAUDE_CONFIG_DIR` | Blocks repository hooks and MCP config, and keeps apps' histories apart | Inheriting the operator's Claude config |
| D8 | **Structured output** through `--json-schema` from the manifest's `outputSchema` | Claude Code enforces it natively | Re-prompting for valid JSON |

## Scheduling and limits

| # | Decision | Why |
|---|---|---|
| D9 | **Postgres is the only queue and bus:** `FOR UPDATE SKIP LOCKED`, leases plus heartbeat, `LISTEN/NOTIFY` | One source of truth, so there's no state drift after crashes. Rejected: Redis/BullMQ and message brokers |
| D10 | **Two-stage claim:** an SQL pre-filter, then a pure policy function in the same transaction | The policy (windows, pauses, budgets, slots) can be tested with plain tables |
| D11 | **Slots:** `worker.concurrency` (2), of which at most `worker.longJobSlots` (1) go to `long` skills | Quick jobs are never starved by long batches |
| D12 | **Plan-limit guard:** the live `rate_limit_event` utilization (5-hour and 7-day) gates new starts per class. Limit messages pause a scope (`global` or `model:<family>`) until the reset | Keeps headroom for interactive use and avoids failing jobs one after another |
| D13 | **Daily weighted-token budget per app:** `input + output + cache_creation + cache_read × usage.cacheReadWeight`. Checked at submit, at claim, and in flight. Past the hard cap the job is cancelled | Cache reads dominate Claude Code usage. Weighting keeps budgets meaningful |
| D14 | **Run windows** (app ∩ skill, IANA time zones, may cross midnight), `runAfter`, and admin `urgent`, which skips only the window | Batch work runs off-hours without blocking urgent work |
| D15 | **Model per job,** limited to the app's `allowedModels`. Never silently fall back to another model | Opus and Sonnet have different limits and costs |

## Reliability

| # | Decision | Why |
|---|---|---|
| D16 | **A guarded state machine** (`assertTransition` plus `WHERE status IN …`). Terminal states are immutable | Concurrent workers and cancels can't corrupt a job's state |
| D17 | **Separate `failed` from `needs_review`** | An unknown outcome must never look like "nothing happened" |
| D18 | **Retry ladder:** no mutating tool ran → fresh retry. Otherwise resume the session. Otherwise a fresh retry only if nothing outside the workspace changed or the skill is `rerunSafe`. Otherwise `needs_review`. Infra failures and limit waits don't count against `job.maxAutoRetries` | Retrying a job that already changed things can duplicate side effects |
| D19 | **Retries use the latest skill version** and re-check the input against it | Only the current version is on disk. Each attempt records the version it ran |
| D30 | **Infra retries are uncounted but bounded** (`maxAutoRetries × 3 + 3` attempts in total) | A permanent misconfiguration (bad repo URL, missing token) must not retry forever |
| D31 | **Delivery is marked `pending` in the finishing transaction.** The reaper completes deliveries left stranded by a crash | Clients never see `succeeded` with an unknown delivery state |
| D34 | **Explicit tool allow-list** (`--tools`): `Read`, plus edit tools for editing skills, `StructuredOutput` when there's an output schema, and the families the manifest grants | Denylists miss new tools; Claude Code ships scheduling, messaging and subagent tools a job must never have |
| D35 | **No slash commands; the gateway injects `SKILL.md`.** Skills get `--disable-slash-commands`, no `Skill` tool, and `allowed-tools` in `SKILL.md` is rejected | Verified: invoking a skill grants its `allowed-tools`, and bundled skills shadow same-named gateway skills |
| D36 | **Acting is counted from tool results, not tool calls** | A denied call changes nothing; a call cut off by a crash counts, to stay conservative |
| D37 | **LangFuse tracing from the gateway,** opt-in. Traces are built from the attempt's stream after the job is finalized; an export failure never affects the job | Claude Code's model calls aren't instrumentable from outside, but its stream carries per-message usage, models and tool calls. No content leaves unless the skill opts in |
| D20 | **Idempotency:** `Idempotency-Key` with a unique `(app_id, idempotency_key)` index. The same key with a different body gives 409 | Safe client retries |

## Access and data

| # | Decision | Why |
|---|---|---|
| D21 | **An app is the tenant.** Every app-facing query filters on `app_id`, and not-yours returns 404 | Isolation by construction, enforced in the repositories |
| D22 | **API keys in `api_keys`:** SHA-256 hashed, scoped, expirable, revocable, shown once | Rotation and least privilege per caller |
| D23 | **Browser streams** use a 10-minute job-scoped token and an origin allow-list | Long-lived API keys never reach a browser |
| D24 | **Repos are cloned per job with a separate git dir.** The gateway alone delivers `patch`, `branch` or `pr`. A delivery failure keeps the job `succeeded` | Claude never holds push credentials or `.git` internals |
| D25 | **Content isn't logged by default.** Skills opt in with `logContent`. Inputs go in as `ws/input.json`, never pasted into the prompt | Confidential code and data stay out of logs, and caller text can't rewrite instructions |
| D26 | **New features sit behind per-app flags** (`apps.features`), off by default | Safe rollout |

## Platform

| # | Decision | Why |
|---|---|---|
| D27 | **node-config** with `default.json` holding every key. Never `config/local.json`, because node-config loads it in every environment | A single, reviewable source of configuration |
| D28 | **Node 20, CommonJS, Express, Sequelize, Motifer.** `config` v3, since v5 needs Node 22+ | Matches the team's stack |
| D32 | **Queries inside a transaction run one after another** | A transaction owns one connection; concurrent queries on it are deprecated in `pg` and unsafe |
| D33 | **Permission mode per skill:** `dontAsk` for read-only skills, `acceptEdits` for skills that edit files | Verified: `dontAsk` blocks even workspace writes, and `acceptEdits` confines writes to the working directories |
| D29 | **Credential profile per skill:** `max-subscription` (`CLAUDE_CODE_OAUTH_TOKEN`) or `api-key`. `ANTHROPIC_API_KEY` is removed from the child environment unless the profile is `api-key`. No account rotation | Explicit, auditable credential use within the provider's terms |
