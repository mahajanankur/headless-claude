# Security

The gateway runs an AI agent that can read files, run commands and call networks on behalf of other services. **The sandbox boundary, not the prompt, is the security control.**

## Threat model (summary)

| Threat | Control |
|---|---|
| Prompt injection through repositories, documents, logs or database rows | The job can only use what its skill manifest grants. The sandbox limits files, network and resources |
| Reading host files | No bare file-tool allow rules. File access stays inside the workspace and the skill directories. The container mounts only the attempt workspace and the app's Claude home |
| Hostile repository config (`.claude/` hooks, `.mcp.json`) | `--setting-sources user` plus a per-attempt read-only settings file |
| Credential theft | Gateway credentials, DB URLs and git push credentials never enter the sandbox. Secrets are redacted from logs and events |
| Cross-app access | Every app-facing query is scoped by `app_id`. Each app has its own Claude home. Not-yours returns 404 |
| Cloud metadata and lateral movement | `169.254.169.254` is blocked for sandboxes (`ops/host/block-metadata.sh`). A per-skill egress allow-list proxy is **not shipped yet** (`runner.egressProxy` is wired; see the roadmap), so other outbound traffic from a sandbox is allowed today |
| Runaway cost or resource use | Timeouts, `--max-turns`, output caps, CPU/memory/pids limits, slot limits, daily token budgets, plan-limit guard |
| Duplicate side effects | `needs_review` instead of blind retries once a job has acted. Idempotency keys |
| Data sent to tracing | Optional LangFuse export carries ids, token usage, models, tool names and outcomes. Prompts, inputs and outputs are included only for skills with `logContent: true`, and are redacted |
| Webhook SSRF | Per-app host allow-list, private and link-local addresses refused after DNS resolution, no redirects, HMAC signatures |

**Accepted risk:** a skill can do whatever its manifest grants, so a prompt injection could misuse those grants. Review manifests like code.

## Reporting a vulnerability

Please **do not open a public issue.** Report it privately through [GitHub security advisories](https://github.com/mahajanankur/headless-claude/security/advisories/new) with:
- a description
- reproduction steps
- the affected version

We'll acknowledge within 3 working days.
