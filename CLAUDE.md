# headless-claude

A Node.js service that runs reusable Claude Code **skills** as sandboxed **background jobs** for other backend services.
- **API process** (`src/api/server.js`): accepts and serves jobs.
- **Worker process** (`src/worker/index.js`): claims jobs from Postgres and runs `claude -p` inside a runner (`docker` | `host` | `local`) through `ccwrap`.

## Binding rules

| File | Loads for | Covers |
|---|---|---|
| `.claude/rules/backend.md` | all code | Layering, app isolation, transactions, errors, logging, config, style, review checklist |
| `.claude/rules/skills.md` | `skills/**` | Writing skill manifests (they're a security boundary) |
| `.claude/rules/testing.md` | `test/**` | Fake claude, the test DB, required test cases |
| `.claude/rules/docs.md` | `docs/**`, `*.md` | Keeping docs true to the code |

**Conflict order:** app isolation & sandbox safety → data atomicity → API contract → minimal patch → style.

## Commands

```bash
npm run setup                  # one-time, idempotent local setup (DB, migrations, secrets, Claude token, API keys)
npm run dev                    # API + worker together
npm run check                  # format check + lint + all tests (run before saying "done")
npm test                       # unit tests (no database)
npm run test:integration       # API + worker + local runner + FAKE claude against cc_gateway_test
GW_DOCKER_TESTS=1 npm run test:integration   # + docker runner (needs runner images, see the test file)
npm run db:migrate | db:migrate:test | db:migrate:undo
npm run skills:sync            # validate + register skills/ (exit 1 if any skill is invalid)
npm run app:create -- --name x --skills repo-review --features waitModeActive
npm run secrets:init | secrets:set -- claudeOauthToken
npm run start:api | start:worker
npm run docs:config            # regenerate docs/configuration.md tables after changing config keys
```

## Where things live

```
config/                      node-config JSON + index.js (loader) + paths.js       → docs/configuration.md
src/api/                     routes/index.js (every route, auth, scope) · controllers · validators · middlewares · socket.js
src/services/                business rules; pure policies: schedulingPolicy, retryPolicy, outcome, usage
src/repositories/            all queries; app-facing methods require appId; worker-only methods end in *Internal
src/db/                      models/ · migrations/ · config.js (sequelize-cli)
src/worker/                  worker.js (loops, recovery, reaper) · attemptSupervisor.js (one attempt) · argsBuilder.js
src/worker/runners/          local · docker · host · wrapper/ccwrap.js (runs in the sandbox; imports nothing)
src/worker/git/              repoManager (hidden git dir) · github (PRs)
src/infra/                   notifyHub (LISTEN/NOTIFY) · advisoryLock · secrets · langfuse (optional tracing)
src/constants/               frozen enums + the job state machine (jobStatus.js)
skills/<name>/               manifest.json + .claude/skills/<name>/SKILL.md (repo-review, chat)
test/fixtures/fake-claude/   fake `claude`, driven by input.scenario (no real usage)
docs/                        api · architecture · decisions · deployment · configuration · claude-code-behavior · roadmap
```

## Invariants (breaking one is a bug)

**Jobs and state**
- **State changes** go through `jobRepository.transitionInternal` with the allowed `from` statuses, plus a status event in the same transaction.
- **Terminal states are immutable.**
- **`failed` means certainly nothing changed outside the workspace.** Otherwise the job is `needs_review`.
- **Never retry an attempt that acted outside its workspace** unless the skill is `rerunSafe`. Prefer resuming the session (`retryPolicy.service.js`).

**Data access**
- **App isolation:** every app-facing query filters on `appId` from `req.context`. Not-yours returns 404.
- **Layering:** the worker calls services only, never repositories.
- **Transactions:** no I/O inside a transaction (spawn, git, HTTP, files), and no `Promise.all` inside one (one connection).

**Talking to Claude Code**
- **Never trust the `claude` exit code.** Classify from the final `result` event (`outcome.service.js`).
- **Never pass bare file tools** (`Read`, `Write`, …) in `--allowedTools`: a bare `Read` lets Claude read any file on the host.
- **The session's tools are an explicit `--tools` allow-list,** and slash commands are disabled. The gateway injects `SKILL.md` itself, because invoking a skill grants its `allowed-tools` and bundled skills shadow same-named ones.
- **Acting is counted from tool *results*:** a denied call changed nothing.
- **The Claude process gets an environment built from scratch** (`argsBuilder.buildEnv`). Gateway secrets, DB URLs and git push credentials never enter the sandbox.
- **Runner policy:** `local` is refused in production. `development.json` must never set `runner.mode`.

## Verified Claude Code facts (see docs/claude-code-behavior.md)

**Exit codes and results**
- SIGINT exits `0`.
- Auth errors report `subtype: "success"` with `is_error: true`.
- `--max-turns` works but is hidden from `--help`.

**Permissions**
- `--permission-mode dontAsk` blocks even workspace writes. File-editing skills use `acceptEdits`, which confines writes to the working dirs.

**Config, sessions and limits**
- `--setting-sources user` stops a repo's `.claude/settings.json` hooks from loading.
- A custom `CLAUDE_CONFIG_DIR` loses the macOS keychain login, so per-app homes need `CLAUDE_CODE_OAUTH_TOKEN`.
- `--resume` works from any cwd.
- `rate_limit_event` carries live 5-hour and 7-day plan utilization.
- 2.1.312 has no `Grep`/`Glob`/`LS` tools. Bundled commands (`code-review`, `simplify`, `verify`, …) are reserved names.

## Gotchas learned here

**Config**
- **node-config:** use v3 (v5 needs Node 22). Never create `config/local.json`; it loads in every environment.
- **Environment variables** outrank `NODE_CONFIG`.
- **Tests read only `TEST_DATABASE_URL`** from `.env.local`. Test secrets live at `var/test/secrets.json`.

**Code**
- **Sequelize:** don't rename `createdAt`/`updatedAt` in `define`; `underscored: true` already maps them.
- **Supertest:** requests are lazy, so an un-awaited request is never sent.

**Packaging**
- **`sequelize-cli` is a runtime dependency:** the production image runs the migrations.
- **`.dockerignore` excludes `test/`:** the fake runner image builds from `test/fixtures/fake-claude`.

**Local environment**
- **The local Postgres container is shared:** touch only `cc_gateway` and `cc_gateway_test`.

## Working here

- **Real Claude runs cost the owner's plan allowance.** Use the fake claude. Only the `real-smoke` skill runs real Claude, on Haiku, and only when asked.
- **Schema changes:** generate the migration with sequelize-cli and update the model in the same change (expand → migrate → contract once released).
- **Changing behaviour or config:** update `docs/` in the same change, and record new design choices in `docs/decisions.md`.
- **No new npm dependency without the owner's approval.**
