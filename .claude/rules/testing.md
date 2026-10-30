---
paths:
  - "test/**"
  - "jest.config.js"
---

# Testing rules

## Never spend real Claude usage in tests
- **Default suites never call real Claude.** Integration tests run the real API, worker and runner with the fake `claude` (`test/fixtures/fake-claude/claude`).
- **Scenarios** are chosen by the job input's `scenario`:
  - outcomes: `success`, `write_out`, `edit_repo`, `no_output`
  - failures: `bash_then_crash`, `crash`, `limit`, `auth`
  - timing: `hang`, `slow`, `expensive`
- **New behaviour gets a new scenario.** Its output must match the shapes recorded in `test/fixtures/claude/*.jsonl`.
- **Recorded fixtures** must be scrubbed of personal data: user paths, emails, org names, plugin lists, session ids that matter.
- **Docker-runner tests stay opt-in** (`GW_DOCKER_TESTS=1`).

## Database
- **Integration tests use only `cc_gateway_test`.** `test/helpers/db.js` refuses any other database or host. Never weaken that check.
- **Each test starts from `truncateAll()`** (through `setupGateway()` for API and worker tests).
- **Close what you open:** `afterAll` stops `notifyHub` and closes `sequelize`; `afterEach` stops any worker. The suite must exit on its own, with no `--forceExit`.

## Every feature covers
1. the happy path
2. validation errors
3. the wrong scope (403)
4. **another app gets 404** for this app's resources
5. the feature flag off (404) where a flag applies

A bug fix starts with a test that fails without the fix.

## Pitfalls
- **Supertest requests are lazy:** always `await` them (or `.end()`), otherwise nothing is sent.
- **Wait on state, not time:** use `waitForJob(..., predicate)`, not fixed sleeps. Short sleeps are only for "this did *not* happen" checks.
- **Delivery is asynchronous after success:** wait for `delivery.status !== 'pending'`.
- **Keep unit tests pure:** they must not import modules that load `src/db/models` (CI runs them without a database).
- **Clean up temp dirs** (`fs.mkdtempSync` → `fs.rmSync` in `afterEach`/`afterAll`).
- **Tests may read `process.env`** (e.g. `GW_DOCKER_TESTS`); application code may not.
