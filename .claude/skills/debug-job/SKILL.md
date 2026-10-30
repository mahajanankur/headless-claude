---
name: debug-job
description: Investigate why a gateway job failed, hung, needs review or behaved unexpectedly — read its status, attempts, events, workspace stream, exit record and classification. Use when given a job id or a report like "job X is stuck/failed".
---

# Debug a job

Work from evidence, cheapest first. Never print secrets or full prompt or output content into the conversation unless asked.

1. **API view:** `GET /api/v1/jobs/:id`. Look at `status`, `error`, `attempts[]` (mode, errorClass, subtype, terminalReason, numTurns), `delivery` and `possiblyPartial`.
2. **Events:** `GET /api/v1/jobs/:id/events?limit=200`. Look at status transitions, tool names, `rate_limit` events and the final `result` summary.
3. **Database** (local): `job_attempts` for `runtime_handle`, `workspace_path`, `stream_offset`, `started_acting`, `acted_outside_workspace`, `claude_session_id`. Read `provider_state` for `pause:*`, `usage` and `health`.
4. **Attempt files** under `<dataDir>/jobs/<jobId>/a<n>/`:
   - `run/stream.jsonl`: the raw stream; read the last lines.
   - `run/exit.json`: `reason` is one of `timeout`, `cancel`, `budget`, `output_limit`.
   - `run/stderr.log`, `result.json`, and `meta/settings.json`.
5. **Classify:** apply `src/services/outcome.service.js` to the final `result` event. Remember that the exit code is never trusted, and auth errors report `subtype: success`.
6. **Explain the next state** with `src/services/retryPolicy.service.js` (resume, fresh, review, bounded infra retries) and `schedulingPolicy.service.js` (why it's still queued: slots, pause, usage threshold, budget, window).
7. **Runner state:**
   - docker: `docker ps -a --filter label=gw.job=<id>`
   - host: `systemctl status gw-<attemptId>`
   - local: whether the `run/pid.json` pid is alive
8. **Report** the cause, the evidence and the fix. If it's a bug, reproduce it with a fake-claude `scenario` test before fixing.
