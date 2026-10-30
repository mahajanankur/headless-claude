---
name: verify-release
description: Run every quality gate for this repo before declaring work done or cutting a release — format, lint, all tests, docker runner tests, audit, image builds, docs drift and a personal-data scan — and report results faithfully. Use when asked to "verify", "make sure everything works", or before publishing.
---

# Verify a release

Run each step and report what actually happened: exit codes and counts. Don't hide failures and don't skip steps silently.

1. **Main gate:** `npm run check` (format, lint, unit and integration tests). It must exit 0 **without** `--forceExit`.
2. **Docker runner** (if Docker is available):
   ```bash
   docker build -f Dockerfile.runner -t headless-claude-runner .
   docker build -f test/docker/Dockerfile.fake-runner -t headless-claude-runner:fake test/fixtures/fake-claude
   GW_DOCKER_TESTS=1 NODE_ENV=test npx jest --selectProjects integration --runInBand test/integration/dockerRunner.test.js
   ```
3. **Production image:** `docker build -t headless-claude .`, then check that it runs as `node`, has no dev dependencies, and that `node_modules/.bin/sequelize-cli` exists.
4. **Audit:** `npm audit --omit=dev --audit-level=high` (what CI enforces). Report anything below high too.
5. **Docs drift:**
   - `npm run docs:config` must leave `docs/configuration.md` unchanged.
   - Every route in `src/api/routes/index.js` must appear in `docs/api.md`.
6. **Privacy scan:**
   ```bash
   grep -rnIE "/Users/|/home/[a-z]|[A-Za-z0-9._%+-]+@[a-z0-9-]+\.(com|io|net|org)|sk-ant-|gwk_[A-Za-z0-9_-]{20}" \
     --exclude-dir=node_modules --exclude-dir=var --exclude=package-lock.json --exclude=.env.local --exclude='.secrets*.json' .
   ```
   Expected hits only: fake keys in `test/unit/redactor.test.js` and `test/integration/api.test.js`, the patterns in `src/utils/redactor.js`, the container home `/home/claude` in `src/worker/runners/docker.runner.js`, and this skill. Anything else is a leak; remove it.
7. **Report:** Done / Failed / Not run (with the reason) for each step, and state plainly what wasn't verified (for example real Claude, or the Linux `host` runner).
