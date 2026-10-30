# Configuration

Configuration uses [node-config](https://github.com/node-config/node-config). The loader is [`config/index.js`](../config/index.js), and code reads values with `config.get('section.key')`. The tables below are generated from the config files.

**Files:**

| File | Role |
|---|---|
| `config/default.json` | **Every** key, with a safe default |
| `config/development.json` | Local development (`NODE_ENV=development`, the default). It never changes the runner, so an unset `NODE_ENV` can't make jobs run unsandboxed |
| `config/test.json` | Tests (`NODE_ENV=test`): fake `claude`, test skills, local runner, fast timings |
| `config/production.json` | Production paths, reaper and retention on, `trustProxy` |
| `config/custom-environment-variables.json` | Env var → key mapping. The only way secrets enter configuration |

**How each environment loads values:**

| Environment | What it reads from `.env.local` |
|---|---|
| Development | The whole file (see `.env.example`) |
| Test | Only `TEST_DATABASE_URL`. Developer overrides never leak into tests |
| Production | Nothing. It uses the environment, or `.env.production` with Compose |

**Secrets** (DB URL, Claude token, API key, stream-token secret, encryption key, manifest secrets, git credentials) come from environment variables or the secrets file (`paths.secretsFile`, mode 0600, managed with `npm run secrets:init` / `secrets:set`). Every secret value is registered with the log redactor.

**Never create `config/local.json`:** node-config loads it in every environment, production included.

## Environment variables

| Variable | Key | Format |
|---|---|---|
| `PORT` | `server.port` | number |
| `CORS_ORIGINS` | `server.corsOrigins` | JSON |
| `TRUST_PROXY` | `server.trustProxy` | boolean |
| `DATABASE_URL` | `postgres.url` |  |
| `DB_LOGGING` | `postgres.logging` | boolean |
| `DB_POOL_MAX` | `postgres.poolMax` | number |
| `CLAUDE_BIN` | `llm.claudeBin` |  |
| `CLAUDE_PINNED_VERSION` | `llm.pinnedVersion` |  |
| `ALLOWED_MODELS` | `llm.allowedModels` | JSON |
| `WORKER_RUNTIME` | `runner.mode` |  |
| `SANDBOX_MODE` | `runner.sandbox` |  |
| `RUNNER_DOCKER_IMAGE` | `runner.dockerImage` |  |
| `RUNNER_DOCKER_NETWORK` | `runner.dockerNetwork` |  |
| `RUNNER_EGRESS_PROXY` | `runner.egressProxy` |  |
| `RUNNER_DOCKER_USER` | `runner.dockerUser` |  |
| `JOB_MEMORY_MAX` | `runner.memoryMax` |  |
| `JOB_CPUS` | `runner.cpus` |  |
| `GW_HOST_ID` | `worker.hostId` |  |
| `WORKER_CONCURRENCY` | `worker.concurrency` | number |
| `LONG_JOB_SLOTS` | `worker.longJobSlots` | number |
| `USAGE_LONG_JOB_MAX` | `usage.longJobMaxUtilization` | number |
| `USAGE_QUICK_JOB_MAX` | `usage.quickJobMaxUtilization` | number |
| `GW_DATA_DIR` | `paths.dataDir` |  |
| `GW_SKILLS_DIR` | `paths.skillsDir` |  |
| `GW_SECRETS_FILE` | `paths.secretsFile` |  |
| `LOG_LEVEL` | `logging.level` |  |
| `WEBHOOK_ALLOW_PRIVATE_HOSTS` | `webhook.allowPrivateHosts` | boolean |
| `CLAUDE_CODE_OAUTH_TOKEN` | `secrets.claudeOauthToken` |  |
| `ANTHROPIC_API_KEY` | `secrets.anthropicApiKey` |  |
| `STREAM_TOKEN_SECRET` | `secrets.streamTokenSecret` |  |
| `GW_ENCRYPTION_KEY` | `secrets.encryptionKey` |  |
| `LANGFUSE_PUBLIC_KEY` | `secrets.langfusePublicKey` |  |
| `LANGFUSE_SECRET_KEY` | `secrets.langfuseSecretKey` |  |
| `GIT_ALLOWED_HOSTS` | `git.allowedHosts` | JSON |
| `REAPER_ENABLED` | `scheduler.reaperEnabled` | boolean |
| `RETENTION_ENABLED` | `scheduler.retentionEnabled` | boolean |
| `LANGFUSE_ENABLED` | `langfuse.enabled` | boolean |
| `LANGFUSE_BASE_URL` | `langfuse.baseUrl` |  |

## Keys by section

| Section | Keys |
|---|---|
| `server` | `port`, `bodyLimit`, `corsOrigins`, `shutdownGraceSec`, `trustProxy` |
| `postgres` | `url`, `logging`, `poolMax`, `statementTimeoutMs` |
| `auth` | `apiKeyPrefix`, `streamTokenTtlSec`, `streamMaxConnectionSec`, `streamTokenIssuer` |
| `rateLimit` | `windowSec`, `perKey`, `perIp` |
| `pagination` | `defaultLimit`, `maxLimit` |
| `job` | `maxInputBytes`, `waitMaxSec`, `minTimeoutSec`, `maxTimeoutSec`, `maxStreamLineBytes`, `maxOutputBytes`, `maxArtifactBytes`, `eventSummaryMaxChars`, `maxAutoRetries`, `retryBaseDelaySec`, `maxEventsPerPage`, `retryMaxDelaySec`, `cancelGraceSec`, `maxPatchBytes` |
| `llm` | `allowedModels`, `defaultModel`, `claudeBin`, `pinnedVersion`, `settingSources`, `permissionMode`, `editPermissionMode`, `alwaysDisallowedTools` |
| `runner` | `mode`, `sandbox`, `dockerImage`, `memoryMax`, `cpus`, `pidsLimit`, `runAsUser`, `hostHelper`, `killGraceSec`, `dockerUser`, `dockerNetwork`, `egressProxy`, `tmpfsSize`, `ccwrapPath`, `containerCcwrapPath`, `containerClaudeBin`, `containerNodeBin` |
| `worker` | `hostId`, `concurrency`, `longJobSlots`, `pollMs`, `claimBatch`, `leaseSec`, `heartbeatSec`, `reattachGraceSec`, `tailIntervalMs`, `eventBatchSize`, `healthIntervalSec`, `webhookIntervalSec` |
| `usage` | `cacheReadWeight`, `longJobMaxUtilization`, `quickJobMaxUtilization`, `softCapRatio` |
| `stream` | `heartbeatSec` |
| `scheduler` | `reaperEnabled`, `reaperIntervalSec`, `retentionEnabled`, `eventsRetentionDays`, `jobsRetentionDays`, `failedWorkspaceRetentionDays` |
| `paths` | `dataDir`, `skillsDir`, `secretsFile` |
| `logging` | `level` |
| `webhook` | `timeoutMs`, `maxAttempts`, `maxAgeHours`, `allowPrivateHosts`, `batchSize` |
| `git` | `bin`, `cloneDepth`, `timeoutSec`, `githubApiUrl`, `allowedHosts`, `allowFileUrls`, `authorName`, `authorEmail` |
| `sessions` | `defaultTtlHours`, `maxTtlHours` |
| `secrets` | `claudeOauthToken`, `anthropicApiKey`, `streamTokenSecret`, `encryptionKey`, `langfusePublicKey`, `langfuseSecretKey` |
| `langfuse` | `enabled`, `baseUrl`, `flushAt`, `flushIntervalMs`, `requestTimeoutMs`, `maxGenerations` |

See `config/default.json` for every default value.
