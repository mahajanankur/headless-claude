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

## External skills (v0.2)

| # | Decision | Why |
|---|---|---|
| D38 | **Skills come from three sources:** API upload, a git source with "sync now", and a shared admin folder, next to the built-ins | The gateway is installed like a package; teams add skills without changing it |
| D39 | **Apps own their skills.** Other apps can't see or run them; an app can't take the name of a live gateway skill (D51) | Tenant isolation extends to skills; one name never means two things for one app |
| D40 | **No per-app ceiling on what an app's own skill may request,** except shell and MCP servers (D50). The gateway-wide validator and the sandbox still apply | Teams own their skills. The blast radius is the app's own workspace, home, secrets and budget |
| D41 | **App secrets are per app** (encrypted in `app_secrets`). App skills reference only their own; gateway skills keep the secrets file | With app-written manifests, a shared secrets file would let one app read another team's credentials |
| D42 | **App skills always use the default credential profile** | Otherwise an app could bill the gateway's API key |
| D43 | **Versions never change; jobs may pin one.** The content checksum (over files, not archive bytes) identifies a version | Running jobs keep their files; re-uploading the same folder is a no-op |
| D44 | **Postgres stores the packages; each worker host keeps a read-only unpacked cache** by checksum | Works with several worker hosts and adds no storage service |
| D45 | **Git sync runs on the worker in the background** ("sync now", optional `?wait=`) | Cloning stays out of the API request path and reuses the hardened `repoManager` |
| D46 | **Uploads are a raw `application/gzip` body, unpacked with the `tar` package plus our own checks** (regular files only, under `manifest.json`/`.claude/`, size and count caps, bounded gunzip) | No multipart dependency; a proven tar reader instead of a hand-written one |
| D47 | **Built-in skills resolve from the package; data, secrets and `.env.local` from the working folder** (`GW_HOME`, default the current directory) | An npm-installed gateway keeps its state where it is run, never inside `node_modules` |
| D48 | **Published as an npm CLI and GHCR images from a version tag** | Install and run without cloning the repository |
| D49 | **Job sandboxes keep open network access in v0.2** | Accepted risk; blocking private addresses is on the roadmap |
| D50 | **An app's own skill gets Bash or MCP servers only when an admin turns on `skillsShellActive` for the app, and never file path rules (`Read(//…)`). Every run denies reading or editing the app's Claude home and `/proc`, and passes `--strict-mcp-config`. No skill may set env names that redirect Claude or load code** (`ANTHROPIC_*`, `CLAUDE*`, `NODE_*`, `LD_*`, `*_PROXY`, `PATH`, `HOME`, …) | The Claude credential is in the sandbox's environment, so code a team's skill runs could read it and use the plan outside the gateway's budgets. **Known exposure:** an app with `skillsShellActive` can still read it; keeping the credential out of the sandbox (an auth-adding proxy) is on the roadmap |
| D51 | **Names:** a name shipped as a built-in, or used by a gateway skill that is not removed, can't be taken by an app. A gateway skill and an app's skill of the same name can coexist; the owning app runs its own | A gateway skill that is broken for a moment can't be taken over, and a folder coming back never breaks the app that took the freed name |
| D52 | **A live skill keeps every version; deleting a skill frees its name** (the row is renamed and removed by retention) | Old pins keep working; uploading a deleted name starts afresh |
| D53 | **A git sync holds a lease renewed by the worker heartbeat;** it is taken over only after `worker.leaseSec` without renewal, and the outcome is written only by the worker that still holds the claim. One queued or running sync per source (unique index) | A long clone is never run twice, and a late worker can't overwrite the result of the one that took over |
| D54 | **"Latest" for an app skill is the highest enabled version number,** not the newest upload | A hotfix to an older line must not silently downgrade unpinned jobs |
| D55 | **A skill that can't be prepared for a fixed reason (missing, blocked, a `uses` skill not available, a missing or corrupt package) fails the attempt as `validation`,** not `gateway` | It would fail the same way on every retry; only I/O errors stay `gateway` and are retried |
| D56 | **Manifest env names stay a denylist** (extended to code-loading and redirecting names: `JAVA_*`, `XDG_*`, `GCONV_*`, `SSL*`, `TMP`, `PROMPT_COMMAND`, `HOSTALIASES`, …), not an allowlist | Values come only from the app's own secrets, and tools need their standard names (`GH_TOKEN`, `AWS_REGION`). Reviewed 2026-11-10 |
| D57 | **The LISTEN connection turns off `idle_session_timeout` with a query after connecting,** skipped when the server doesn't know it | A startup option makes every connect fail on Postgres < 14 and through pgbouncer |
