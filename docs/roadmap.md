# Roadmap

✅ done · ⬜ next

## v0.1: complete gateway ✅
- ✅ **Configuration:** node-config, deterministic test config, fail-fast secrets, a secrets helper (`npm run secrets:*`)
- ✅ **Data:** schema, models and repositories, with app isolation enforced in the repositories
- ✅ **Skills:** registry, manifest schema, bulk sync, the `repo-review` skill
- ✅ **API:** auth (hashed, scoped API keys), validation, envelope, rate limits, jobs, skills, sessions, admin, health/ready
- ✅ **Scheduling:** two-stage claim (SQL + pure policy), quick/long slots, per-app concurrency, run windows, `urgent`, `runAfter`, plan-utilization thresholds, per-model limit pauses
- ✅ **Execution:** `ccwrap`, the `local` / `docker` / `host` runners, stream tailing, outcome classification from the `result` event, structured output, artifacts
- ✅ **Reliability:**
  - the retry ladder (resume → fresh → review) with bounded infra retries
  - timeouts, cancel, the hard budget cap
  - re-attach after a worker restart, finalizing jobs left by dead hosts
  - a crash-safe `result.json`, the reaper, retention
- ✅ **Change delivery:** per-job clone with a hidden git dir, `patch` / `branch` / `pr` (GitHub), recovery of stranded deliveries
- ✅ **Delivery channels:** `?wait=`, SSE, Socket.IO, stream tokens, signed webhooks with an SSRF guard
- ✅ **Sessions:** named sessions and `continueFromJobId`, session locks, TTL
- ✅ **Deployment:** gateway and runner images, `compose.prod.yaml`, systemd units, the host-runner helper, metadata blocking, CI
- ✅ **Tests:** unit tests, plus integration tests with a fake `claude` (no real usage) and opt-in Docker-runner tests
- ✅ **Chat:** `POST /api/v1/chat` and history, using the built-in `chat` skill
- ✅ **One-command setup** (`npm run setup`) and `npm run dev`
- ✅ **Admin redelivery** of failed code deliveries
- ✅ **LangFuse tracing** (optional, from the gateway: trace per job, span per attempt, generation per message, tool events)
- ✅ **Verified with real Claude Code** (2.1.312): repository review and multi-turn chat, end to end

## v0.2: external skills and packaging ✅
- ✅ **App-owned skills:** apps upload versioned skill packages (`POST /skills`) or sync them from git ("sync now", run by the worker). Other apps never see them
- ✅ **Skill store:** every skill is stored as versions that never change, with a per-host read-only cache; jobs can pin `skillVersion`
- ✅ **Per-app secrets** (`/secrets`), encrypted, referenced only by the app's own skills
- ✅ **Shared skills folder** (`GW_SHARED_SKILLS_DIR`) next to the built-in skills
- ✅ **CLI** (`headless-claude`): setup, start, migrate, app create, `skills push`, `skills sync`
- ✅ **Release workflow:** npm package and GHCR images on a `v*` tag

## Next ⬜
- ⬜ **Block private network addresses from job sandboxes:** today a skill with Bash can reach whatever the worker host can (accepted for v0.2)
- ⬜ **Per-app limits on what an app's own skills may request** (tools, network hosts), as an option
- ⬜ **Linux host validation:** run [`ops/phase0/probe.sh`](../ops/phase0/probe.sh) on a non-critical host to confirm the bubblewrap sandbox, systemd units and deny rules for the `host` runner
- ⬜ **Egress allow-list proxy** for the Docker runner (`runner.egressProxy` is wired; a reference proxy is still to ship)
- ⬜ **Keep the Claude credential out of the sandbox** (a proxy that adds it outside), so `skillsShellActive` no longer exposes it (D50)
- ⬜ **Prometheus metrics endpoint** (today: `/admin/stats`, structured logs and optional LangFuse traces)
- ⬜ **Claude Code's native OpenTelemetry export** forwarded to LangFuse (unverified; see the gateway-side tracing instead)
- ⬜ **Fan-out batch jobs** (parent job → child jobs → merge step)
- ⬜ **Pull requests for GitLab and Bitbucket**
