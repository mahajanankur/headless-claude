# Costs

The gateway is free and open source. What you pay for depends on how Claude is accessed, and where you host the gateway.

## Claude usage

Each skill picks a credential profile (`credentialProfile` in its manifest).

| Profile | How it's paid | What the gateway measures |
|---|---|---|
| `max-subscription` (default) | **No per-request charge.** Runs count against your Claude plan's usage allowance (a 5-hour window and a 7-day window), shared with your own Claude use | Live plan utilization from Claude Code's `rate_limit_event`, in `GET /api/v1/admin/stats` → `usage`. New jobs wait above `usage.quickJobMaxUtilization` / `usage.longJobMaxUtilization`, so headroom stays for your own work |
| `api-key` | **Billed per token** by Anthropic at API prices | Each attempt records `usage` and `modelUsage`. `modelUsage[*].costUSD` is Claude Code's own list-price figure |

**Example: the real runs made while building this project** (Claude Code 2.1.312, Haiku, the `motifer` repository):

| Run | Weighted tokens | List price reported by Claude Code |
|---|---|---|
| Repository review (first attempt) | 66,609 | $0.015 |
| Repository review (second attempt) | 59,781 | $0.015 |
| Repository review (final) | 35,147 | $0.008 |

On a subscription, these list prices are **reference figures only**. Nothing extra was charged, and the runs used plan allowance instead.

**Model choice matters most.** Opus uses allowance (or money) much faster than Sonnet, and Sonnet faster than Haiku. Limit expensive models per app with `allowedModels`, and per skill with `defaultModel`.

## Controls

| Control | Where |
|---|---|
| Daily weighted-token budget per app: new jobs get `429` at the cap, and a running job is cancelled past it | `dailyTokenBudget` (admin API) |
| Models an app may use | `allowedModels` |
| Max turns and timeout per skill; a caller may only lower the timeout | skill manifest `maxTurns`, `timeoutSec` |
| Concurrency | `worker.concurrency`, `worker.longJobSlots`, app `maxConcurrent` |
| Plan-utilization thresholds | `usage.*` config |
| Run batch work off-hours | `runWindows` on apps and skills |
| Stop everything | `POST /api/v1/admin/intake/pause`, or the per-app kill-switch |

**Budget weighting:** cache reads count at `usage.cacheReadWeight` (0.1 by default). Claude Code re-reads its context constantly, so counting cache reads at full weight would make budgets meaningless.

## Hosting

| Item | Notes |
|---|---|
| A server for the API and the worker | One small VM is enough to start. Each concurrent job runs one Claude Code process (memory is capped by `runner.memoryMax`, 2 GB by default) |
| PostgreSQL | Any managed or self-hosted Postgres 15+ |
| Disk | Workspaces, artifacts and logs. Retention keeps it bounded |

There are no other paid services: no Redis, no queue service, no third-party SaaS.

## Terms

Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page describes subscription OAuth as intended for ordinary, individual use, and points products and services to API keys. Read it, and choose the profile that fits your deployment. The gateway never rotates accounts or works around plan limits.
