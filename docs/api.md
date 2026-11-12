# API reference

**Base path:** `/api/v1`.

**Authentication:** every route except `/health`, `/ready` and token-authenticated streams needs an app API key:

```http
Authorization: Bearer gwk_…
```

**Envelope:** every response uses one shape.

```json
{ "success": true, "message": "Job queued.", "data": { … }, "requestId": "…" }
{ "success": false, "message": "Input (input) does not match the skill input schema.", "error": { "code": "INPUT_INVALID", "details": [ … ] }, "requestId": "…" }
```

**Request id:** send `X-Request-Id` to choose your own. It's echoed in the response header and the body.

## Errors

| Status | Codes |
|---|---|
| 400 | `INPUT_INVALID`, `SKILL_INVALID`, `SKILL_PACKAGE_REJECTED` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN`, `FORBIDDEN_SKILL`, `FORBIDDEN_MODEL` |
| 404 | `NOT_FOUND`, `JOB_NOT_FOUND`, `SKILL_NOT_FOUND`, `SESSION_NOT_FOUND`, `ARTIFACT_NOT_FOUND`, `SKILL_SOURCE_NOT_FOUND`, `SKILL_SYNC_NOT_FOUND`, `SECRET_NOT_FOUND` |
| 409 | `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `SESSION_BUSY`, `SKILL_NAME_TAKEN`, `SKILL_VERSION_EXISTS` |
| 413 | `INPUT_INVALID` (body too large) |
| 429 | `QUOTA_EXCEEDED` (daily budget, with `Retry-After`), `RATE_LIMITED` |
| 503 | `INTAKE_PAUSED` |
| 500 | `INTERNAL_ERROR` |

**Notes:**
- Another app's job, session or artifact is always a 404, never a 403.
- Features that are switched off for your app return 404.

**Rate limits:** every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.

## Jobs

### Submit: `POST /jobs` (scope `jobs:write`)

```json
{
  "skill": "repo-review",
  "input": { "repoUrl": "https://github.com/acme/api.git", "ref": "main", "focus": "security" },
  "model": "sonnet",
  "priority": "normal",
  "timeoutSec": 600,
  "runAfter": "2026-11-01T22:00:00Z",
  "sessionId": "…",
  "continueFromJobId": "…",
  "webhookUrl": "https://hooks.example.com/claude"
}
```

**Required:** only `skill` and `input`. `input` is validated against the skill's `inputSchema`.

**Optional fields:**

| Field | Default | Rules |
|---|---|---|
| `skillVersion` | the latest enabled version (highest version number) | Pin a version (`"1.2.0"`). Retries keep the pin; unpinned jobs and their retries run the latest version |
| `model` | the skill's `defaultModel` | Must be in the app's `allowedModels` |
| `priority` | `normal` | `low`, `normal` or `high` |
| `timeoutSec` | the skill's limit | May only lower it |
| `runAfter` | none | Earliest start time |
| `urgent` | `false` | Admin apps only. Skips the run window only |
| `sessionId` / `continueFromJobId` | none | Needs `sessionsActive`. Skills with `changes: none` only. Use one, not both |
| `webhookUrl` | none | Needs `webhooksActive`. The host must be in the app's `webhookAllowedHosts` |

**Headers and query:**
- `Idempotency-Key`: the same key with the same body returns the existing job (`200`); the same key with a different body gives `409 IDEMPOTENCY_CONFLICT`.
- `?wait=1..55`, which needs `waitModeActive`:
  - Waits for the job to finish. Returns `200` with `data.result` if it did, otherwise `202`.
  - Returns at once when the job can't start yet (waiting for a plan limit, or `runAfter` in the future).

**Responses:**

| Status | Meaning |
|---|---|
| `202` | `data` is the job (`jobId`, `status: "queued"`, …) |
| `200` | Finished within `?wait`, or an existing idempotent job |

### Read and control

| Route | Scope | Notes |
|---|---|---|
| `GET /jobs?limit=&cursor=&status=` | `jobs:read` | Newest first. Pass `data.nextCursor` to page |
| `GET /jobs/:id` | `jobs:read` | Job with its `attempts` (mode, version, model, outcome, turns, tokens) and `delivery` |
| `GET /jobs/:id/result` | `jobs:read` | `{ status, output, error, artifacts }`; `409` until finished |
| `GET /jobs/:id/events?after=&limit=` | `jobs:read` | Progress and audit events: `status`, `init`, `tool_use`, `tool_result`, `assistant_text`, `rate_limit`, `result` |
| `GET /jobs/:id/artifacts` | `jobs:read` | Files the job wrote to `./out/`, plus `changes.patch` for code changes |
| `GET /artifacts/:id` | `jobs:read` | Download (`Content-Disposition: attachment`) |
| `POST /jobs/:id/cancel` | `jobs:write` | Queued → `cancelled`. Running → `cancelling`, then `cancelled` |
| `POST /jobs/:id/retry` | `jobs:write` | Re-queue a `failed`, `timed_out` or `needs_review` job as a fresh attempt |

**Job statuses:**
- **Running:** `queued` → `claimed` → `provisioning` → `running`.
- **Pausing and cancelling:** `waiting_limit` and `cancelling`.
- **Final:** `succeeded`, `failed`, `timed_out`, `needs_review` and `cancelled`.
- **`needs_review`** means the job may have changed something outside its workspace before it stopped. Check its events before retrying.

**Event summaries:** these hold tool names and sizes only, unless the skill sets `logContent: true`.

## Chat (`chatActive`, skill `chat`)

Normal multi-turn conversations without writing a skill. Each message is a job of the built-in `chat` skill, and the conversation is a session.

| Route | Scope | |
|---|---|---|
| `POST /chat?wait=0..55` | `jobs:write` | `{ message, sessionId?, model? }` |
| `GET /chat/:sessionId` | `jobs:read` | `{ sessionId, messages: [{ jobId, status, message, reply, createdAt, finishedAt }] }`, oldest first |

**`POST /chat` behaviour:**
- **Starting and continuing:** omit `sessionId` to start a new conversation; send it back to continue (Claude keeps the earlier turns).
- **Waiting:** it waits up to `wait` seconds, by default the maximum.
- **Responses:** `200` with `{ sessionId, jobId, status: "succeeded", reply }`, or `202` with `reply: null` when the reply isn't ready yet. In that case poll `GET /jobs/:jobId/result` (`output.text`).

The app needs `chat` in `allowedSkills`. The `chat` skill is read-only and has no internet access.

## Live progress

Both stream the same events.

**Server-Sent Events:** `GET /jobs/:id/stream`
- **Backends:** `Authorization: Bearer <api key>`.
- **Browsers:** `?token=<stream token>`. `EventSource` can't send headers.
- **Events:** `job-event` (one row, `id:` is the event id) and finally `end` with `{ "status": … }`.
- **Reconnect:** resumes from `Last-Event-ID`.
- **Keep-alive:** a comment every 15 s.

**Socket.IO:** namespace `/jobs`.

```js
const socket = io('https://gateway.example.com/jobs', { auth: { token } }); // or { apiKey }
socket.emit('subscribe', { jobId, after: 0 });
socket.on('job-event', ({ jobId, events }) => {});
socket.on('job-end', ({ jobId, status }) => {});
socket.on('job-error', ({ jobId, message }) => {});
```

**Stream token:** `POST /jobs/:id/stream-token` (needs `streamTokensActive`) returns `{ token, expiresIn: 600 }`.
- It's valid for that one job only.
- Get it from your backend and pass it to the browser.
- The browser `Origin` must be in the app's `streamOrigins` when that list isn't empty.

## Webhooks

When a job finishes, the gateway POSTs:

```json
{ "event": "job.finished", "jobId": "…", "status": "succeeded", "finishedAt": "…" }
```

**Verifying the request:**
- When the app has a `webhookSecret`, it's signed with `X-Gateway-Signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.
- Reject any request whose timestamp is too old.
- Fetch the result with `GET /jobs/:id/result`.

**Delivery:**
- Retries with backoff for up to 24 hours.
- Redirects aren't followed.
- Private addresses are refused.

## Skills

A job runs the app's **own** skill with that name first, otherwise a **built-in** or **shared** skill granted to the app in `allowedSkills`. Other apps never see an app's own skills.

| Route | Scope | |
|---|---|---|
| `GET /skills` | `skills:read` | Skills the app can run: `name`, `version`, `description`, `class`, `defaultModel`, `changes`, `inputSchema`, `outputSchema`, `owner` (`app`, `shared` or `builtin`) |
| `GET /skills/:name` | `skills:read` | One skill. Own skills add `enabled`, `disabledReason` and `versions[]` (`version`, `checksum`, `sizeBytes`, `enabled`, `createdAt`). `403 FORBIDDEN_SKILL` when the app can't use it |

### Managing your own skills (`skillsManageActive`)

All of these return `404` while the app's `skillsManageActive` flag is off. With the flag off, the app's own skills are also not listed and don't run (queued jobs fail with `SKILL_DISABLED`).

Uploads are refused with `400 SKILL_INVALID` when the skill grants Bash or sets `mcpServers` and the app doesn't have `skillsShellActive` (admin only), or sets a reserved `env` name, or has a file path rule in `allowedTools` such as `Read(//proc/**)` (workspace files need no rule). `409 SKILL_NAME_TAKEN` when the name is a built-in or a live gateway skill.

| Route | Scope | |
|---|---|---|
| `POST /skills` | `skills:write` | Upload a skill package as the raw body (`Content-Type: application/gzip`). `201` new version, `200` identical version already stored (`data.status` `created` or `unchanged`). Returns `{ name, version, checksum, status }` |
| `PATCH /skills/:name` | `skills:write` | `{ "enabled": false }` stops new jobs; `true` turns it back on |
| `PATCH /skills/:name/versions/:version` | `skills:write` | `{ "enabled": false }` hides one version; the skill then runs its highest enabled version |
| `DELETE /skills/:name` | `skills:write` | New jobs stop at once. The name is freed: uploading it again starts afresh, with no old versions |
| `POST /skill-sources` | `skills:write` | Register a git repository: `{ repoUrl, ref?, path?, credentialSecret? }`. `path` is a folder in the repo (default the root); `credentialSecret` names one of your secrets holding a token (or `username:token`) |
| `GET /skill-sources`, `DELETE /skill-sources/:id` | `skills:read` / `skills:write` | List or remove sources. Skills already synced stay |
| `POST /skill-sources/:id/sync` | `skills:write` | "Sync now": the worker clones the repo and stores every folder with a `manifest.json` as a version. `202 { syncId, status }`; with `?wait=1..30`, `200` and the result when it finishes in time |
| `GET /skill-sources/:id/syncs/:syncId` | `skills:read` | `{ status, added[], unchanged[], failed[{ name, error }], error }`. `error.code` is `SKILL_SOURCE_FAILED` when the clone itself failed |
| `PUT /secrets/:name` | `secrets:write` | `{ "value": "…" }`. Stored encrypted, never returned |
| `GET /secrets` | `secrets:write` | Names and `updatedAt` only |
| `DELETE /secrets/:name` | `secrets:write` | |

**Package format:** the skill folder as a gzipped tar, with `manifest.json` and `.claude/skills/<name>/SKILL.md` (plus any reference files under `.claude/`). The CLI builds it for you: `headless-claude skills push <folder>`.

```bash
tar -czf skill.tgz -C my-skill manifest.json .claude
curl -X POST localhost:4100/api/v1/skills -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/gzip" --data-binary @skill.tgz
```

**Rules:**
- **Validation:** the same as gateway skills (manifest schema, `SKILL.md` rules, no bare file tools), plus:
  - `credentialProfile` must be the default
  - only regular files under `manifest.json` and `.claude/`
  - no symlinks
  - at most `skills.maxPackageBytes` packed, `skills.maxUnpackedBytes` unpacked and `skills.maxFiles` files
- **Versions:** a version never changes. The same version with different content is `409 SKILL_VERSION_EXISTS`; bump `manifest.version`. The highest enabled version number is the latest, so uploading a `1.4.1` hotfix after `2.0.0` leaves unpinned jobs on `2.0.0`.
- **Names:** a name used by a built-in or shared skill is `409 SKILL_NAME_TAKEN`.
- **Secrets:** a manifest's `"env": { "TOKEN": "secret:<name>" }` reads the app's own secret `<name>`. Values are at most `skills.maxSecretValueChars` characters. Reserved env names (refused at upload) include those that redirect Claude or load code: `ANTHROPIC_*`, `CLAUDE*`, `NODE_*`, `LD_*`, `GIT_*`, `JAVA_*`, `XDG_*`, `PYTHON*`, `SSL*`, `*_PROXY`, `PATH`, `HOME`, `TMP`, `PROMPT_COMMAND`, `HOSTALIASES` and more (`src/constants/skill.js`).
- **Concurrent "sync now":** requests for a source that already has a queued or running sync join it (same `syncId`).

## Sessions (`sessionsActive`)

A session keeps one Claude conversation and one workspace across jobs. The second job in a session resumes the first job's Claude session. Only one job at a time runs in a session.

| Route | Scope | |
|---|---|---|
| `POST /sessions` | `sessions:write` | `{ name?, ttlHours? }` returns `{ sessionId, name, expiresAt, busy, hasHistory }` |
| `GET /sessions/:id` | `jobs:read` | |
| `DELETE /sessions/:id` | `sessions:write` | `409 SESSION_BUSY` while a job is running in it |

## Admin (admin apps)

| Route | |
|---|---|
| `GET /admin/apps`, `POST /admin/apps`, `GET /admin/apps/:id`, `PATCH /admin/apps/:id` | Manage apps. `POST` returns the first API key once |
| `GET /admin/apps/:id/keys`, `POST /admin/apps/:id/keys`, `DELETE /admin/apps/:id/keys/:keyId` | Keys are shown once, listed as prefix + last 4, and revoked at once |
| `POST /admin/apps/:id/pause`, `POST /admin/apps/:id/resume` | Stop or allow new jobs for one app |
| `POST /admin/apps/:id/kill` | Kill-switch: pause intake and cancel every queued and running job of the app |
| `POST /admin/intake/pause`, `POST /admin/intake/resume` | Stop or allow new jobs for every app |
| `POST /admin/jobs/:id/redeliver` | Retry a failed code delivery (`succeeded` jobs with `delivery.status = failed`). The workspace is kept for this, and the worker redelivers within one reaper interval |
| `GET /admin/stats` | Job counts by status, plan utilization, active pauses, provider health |
| `POST /admin/skills/sync` | Re-read the built-in and shared skill folders now (the worker also does this at start) |

**App settings** (`POST`/`PATCH /admin/apps`):

| Setting | Notes |
|---|---|
| `allowedSkills`, `allowedModels` | Built-in and shared skills, and models, the app may use (its own skills need no grant) |
| `features` | Any of `chatActive`, `sessionsActive`, `changeDeliveryActive`, `webhooksActive`, `streamTokensActive`, `waitModeActive`, `skillsManageActive`, `skillsShellActive` (the app's own skills may grant Bash and MCP servers; code they run can read the Claude credential) |
| `runWindows` | `[{ "tz": "Asia/Kolkata", "from": "22:00", "to": "07:00" }]` |
| `timezone` | IANA time zone |
| `dailyTokenBudget` | Weighted tokens per day |
| `maxConcurrent` | Jobs running at once |
| `webhookAllowedHosts`, `webhookSecret` | Webhook delivery |
| `streamOrigins` | Browser origins for live streams |
| `gitCredentialRef` | Name of a git credential in the secrets file |
| `isAdmin` | Admin access |

## Operations

| Route | |
|---|---|
| `GET /health` | Liveness, with no I/O |
| `GET /ready` | `200` when the database is reachable, with the latest provider health (Claude version, check time); `503` otherwise |
