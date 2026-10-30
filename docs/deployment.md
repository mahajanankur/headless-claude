# Deployment

The gateway is two processes from one image, plus PostgreSQL:
- **API:** `node src/api/server.js`.
- **Worker:** `node src/worker/index.js`.

**Deploy order:** migrate → API → worker.

**Restarting the worker is safe:** running jobs continue and are re-attached.

## 1. Choose a runner

| Runner | Isolation | Use when |
|---|---|---|
| `docker` (default) | One container per attempt: non-root, read-only root filesystem, `--cap-drop ALL`, `no-new-privileges`, CPU/memory/pids limits. Only the attempt workspace and the app's Claude home are mounted | Production on a host you control |
| `host` | A transient systemd unit per attempt, run as the unprivileged `ccrunner` user through `ops/host/gw-runner-helper`. Claude Code's bubblewrap sandbox is required | Linux hosts where you don't want Docker |
| `local` | A detached process of the worker's own user | Development only. **Refused when `NODE_ENV=production`** |

## 2. Credentials and secrets

Set these as environment variables (`.env.production`, see `.env.production.example`) or in the secrets file (`paths.secretsFile`, mode 0600):

| Secret | |
|---|---|
| `DATABASE_URL` | Required |
| `STREAM_TOKEN_SECRET` | Required by the API. 32 random bytes, hex |
| `GW_ENCRYPTION_KEY` | Required. 64 hex characters. Encrypts webhook secrets at rest |
| `CLAUDE_CODE_OAUTH_TOKEN` | For skills with `credentialProfile: max-subscription`. Create with `claude setup-token` |
| `ANTHROPIC_API_KEY` | For skills with `credentialProfile: api-key` |

**Manifest secrets and git credentials** live only in the secrets file:

```json
{
  "values": { "analytics_rw": "postgres://…" },
  "git": { "github-bot": { "username": "x-access-token", "token": "ghp_…" } }
}
```

**How they're referenced:**
- A manifest refers to `"env": { "PGURL": "secret:analytics_rw" }`.
- An app refers to a git credential with `gitCredentialRef: "github-bot"`.

**Subscription terms:** read Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page before using a subscription token for automated jobs.

## 3. Docker Compose (single host, docker runner)

```bash
docker build -f Dockerfile.runner --build-arg CLAUDE_CODE_VERSION=2.1.312 -t headless-claude-runner .
cp .env.production.example .env.production && chmod 600 .env.production   # fill it in
sudo mkdir -p /var/gw && sudo chown 1000:1000 /var/gw
sudo ops/host/block-metadata.sh                                             # block 169.254.169.254 for containers
POSTGRES_PASSWORD=… docker compose -f compose.prod.yaml up -d --build
docker compose -f compose.prod.yaml exec api node scripts/create-app.js --name ops --admin
```

**Important:**
- **The worker controls Docker through the host socket.** Anyone who controls the worker is effectively root on the host, so run it on a host dedicated to the gateway.
- **`/var/gw` must be mounted at the same path** in the worker container and on the host. The worker passes these paths to `docker run`.
- **The API listens on `127.0.0.1:4100`.** Put a TLS-terminating reverse proxy in front of it and keep `server.trustProxy: true` (set in production config).
- **`CLAUDE_PINNED_VERSION` must match the version baked into the runner image.** The worker's health check flags a mismatch.

## 4. systemd (host runner)

```bash
sudo useradd --system --create-home gateway
sudo useradd --system --create-home --shell /usr/sbin/nologin ccrunner
sudo apt-get install -y bubblewrap socat git
npm install -g @anthropic-ai/claude-code@2.1.312
sudo install -o root -g root -m 0755 ops/host/gw-runner-helper /usr/local/sbin/gw-runner-helper
sudo install -o root -g root -m 0440 ops/host/sudoers.gateway /etc/sudoers.d/headless-claude
sudo install -m 0644 ops/host/headless-claude-{api,worker}.service /etc/systemd/system/
sudo ops/host/block-metadata.sh
# /etc/gateway/gateway.env: NODE_ENV=production, WORKER_RUNTIME=host, DATABASE_URL, secrets…
sudo -u gateway npm run db:migrate
sudo systemctl enable --now headless-claude-api headless-claude-worker
```

**Why restarts are safe:** the worker unit uses `KillMode=process`, and every job runs in its own transient unit. Restarting the worker never stops running jobs.

**What the helper accepts:**
- unit names `gw-<uuid>`
- the configured runner user
- paths under `GW_DATA_DIR`

It refuses everything else.

## 5. Skills and apps

```bash
npm run skills:sync                                     # validate and register ./skills (exits 1 if any skill is invalid)
node scripts/create-app.js --name search-api --skills repo-review --models haiku,sonnet --features waitModeActive,webhooksActive
```

The worker also syncs skills at startup.

**App settings:** an admin app manages the other apps through `/api/v1/admin/apps` ([api.md](api.md#admin-admin-apps)).

## 6. Operations

| Concern | Where |
|---|---|
| **Liveness and readiness** | `GET /api/v1/health` and `GET /api/v1/ready` (database, Claude version, health-check time) |
| **Metrics snapshot** | `GET /api/v1/admin/stats`: jobs by status, plan utilization (5-hour / 7-day), active pauses |
| **Plan limits** | The worker reads Claude Code's `rate_limit_event`. Above `usage.longJobMaxUtilization` / `usage.quickJobMaxUtilization` new jobs wait. A rejected limit pauses its scope until the reset |
| **Kill-switch** | `POST /api/v1/admin/apps/:id/kill` (one app) and `POST /api/v1/admin/intake/pause` (everyone) |
| **Retention** | The reaper (`scheduler.reaperEnabled`, on in production) deletes old events, jobs, failed workspaces and expired sessions. It runs on one worker at a time (Postgres advisory lock) |
| **Stuck jobs** | Expired leases from dead hosts are finalized by the reaper, then retried or marked `needs_review`. Deliveries left `pending` by a crash are completed or marked failed |
| **Tracing (optional)** | LangFuse: one trace per job (`id` = job id; chat turns grouped by session), a span per attempt (errors marked), a generation per Claude message with token usage, and tool calls as events (denied calls flagged). Enable with `npm run setup` or `LANGFUSE_ENABLED`, `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. Prompts, inputs and outputs are sent only for skills with `logContent: true` |
| **Logs** | Motifer JSON lines with `requestId`, `appId`, `jobId` and `attemptId`. Secrets are redacted, and prompts and output are never logged unless a skill opts in |

**Runbooks:**

| Symptom | Check | Fix |
|---|---|---|
| Queue backlog | `admin/stats` pauses, plan utilization | Wait for the reset, raise thresholds, or lower load |
| Jobs fail with `provider_auth` | `claude setup-token` expiry, `ready.provider` | Rotate the token and restart the worker |
| Provisioning fails | Worker logs `Launch failed`, `docker images` | Rebuild the runner image, check `/var/gw` permissions |
| Budget overrun | App `dailyTokenBudget` | Raise or lower the budget. Hard caps cancel the running job |
| Leaked API key | `admin/apps/:id/keys` | Revoke the key (takes effect at once), issue a new one |
| `needs_review` jobs | `GET /jobs/:id/events` | Inspect the side effects, then retry or close it out by hand |
