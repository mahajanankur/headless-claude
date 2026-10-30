---
name: real-smoke
description: Run ONE small real Claude Code job end to end through the gateway (real API, worker, local runner, real claude on Haiku) to prove the full path works. Costs the owner's plan allowance — only when explicitly asked.
disable-model-invocation: true
---

# Real end-to-end smoke test

**This spends real usage.** Before running anything, state the planned call: one job, Haiku, a tiny repo, a short timeout.

1. **Preconditions:**
   - `node -e "process.exit(require('./src/infra/secrets').getSecrets().claudeOauthToken ? 0 : 1)"` exits 0. If not, ask the owner to run `claude setup-token` **in their own terminal**, not with `!` (it prints the token), then `npm run secrets:set -- claudeOauthToken`.
   - Postgres is up and migrated, and `claude --version` matches `llm.pinnedVersion` if one is set.
2. **Fixture repo:** create a tiny local git repo in a scratch directory with one small source file that has an obvious bug. Development allows `file://` repo URLs.
3. **Start the processes:**
   - `PORT=4199 GW_DATA_DIR=var/smoke npm run start:api`
   - `GW_DATA_DIR=var/smoke npm run start:worker`
   - Both in the background, with logs to scratch files.
4. **Create an app** with `npm run app:create -- --name smoke-<ts> --skills repo-review --models haiku --features waitModeActive`.
5. **Submit:** `POST /api/v1/jobs?wait=55` with `{"skill":"repo-review","model":"haiku","timeoutSec":300,"input":{"repoUrl":"file://<repo>","ref":"main"}}`.
6. **Check:**
   - `succeeded`, with `result.output` matching the repo-review `outputSchema`.
   - Events include `init`, `tool_use` and `result`.
   - `GET /admin/stats` (with an admin key) shows plan `usage` from the real `rate_limit_event`.
7. **Stop both processes with SIGTERM** and confirm they shut down cleanly.
8. **Report:** status, turns, tokens, duration and anything unexpected. Delete the scratch repo, and leave `var/smoke` for inspection unless asked.
