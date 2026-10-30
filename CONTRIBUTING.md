# Contributing

Thanks for helping. This project runs an AI agent that can execute code, so correctness and safety come before features.

## Setup

```bash
nvm use && npm ci
npm run setup      # Postgres, migrations, secrets, Claude token, API keys (idempotent)
npm run check
```

`npm run check` must pass before you open a pull request. CI runs the same commands.

## Conventions

The binding rules are in [`.claude/rules/backend.md`](.claude/rules/backend.md). The essentials:

- **Layers:** route → controller → validator → service → repository → model. Controllers never touch the DB, services own transactions, repositories own queries, and worker code calls services only.
- **App isolation:** every app-facing query filters on `appId`, and app-facing repository methods require it. Not-yours returns 404. Worker-only lookups are named `*Internal`.
- **Transactions:** use `withTransaction`. No external I/O (spawn, HTTP, git, files) inside one.
- **Errors:** throw the typed errors from `src/utils/AppError.js`. Log the full error once, in the deepest layer.
- **Logging:** use `getLogger(__filename)`. Never log secrets, prompts or Claude output.
- **Config:** add every new key to `config/default.json`, and read it with `config.get()`.
- **Constants:** statuses, event types, scopes and flags live frozen in `src/constants/`. No magic strings.
- **Schema:** changes go through a migration (`npx sequelize-cli migration:generate --name verb-object`), with the model updated in the same change.
- **Style:** Prettier and ESLint, 4 spaces, arrow functions, `async/await`, JSDoc on exports.
- **Dependencies:** a new dependency needs a maintainer's approval in the pull request.

## Tests

- **Unit tests** (`npm test`) cover pure logic and need no database.
- **Integration tests** (`npm run test:integration`) run against `cc_gateway_test` and refuse any other database.
- **Every feature covers:**
  - the happy path
  - validation
  - a wrong scope
  - another app getting 404
  - the feature flag off
- **A bug fix** starts with a failing test.
- **Real Claude runs are never part of the default suites.**
  - Integration tests drive the real API, worker and runner with the fake `claude` in `test/fixtures/fake-claude/`. Its `scenario` input covers success, crashes, limits, auth failures, hangs and slow runs.
  - Recorded outputs live in `test/fixtures/claude/`. If you record new ones, scrub personal data first.
- **Docker-runner tests** are opt-in: `GW_DOCKER_TESTS=1 npm run test:integration`, after building the images listed in `test/integration/dockerRunner.test.js`.

## Skills

Add a folder under `skills/` with a `manifest.json` and a `.claude/skills/<name>/SKILL.md`, then run `npm run skills:sync`. Manifests are a security boundary: review `allowedTools`, `env`, `network` and `changes` carefully.

## Commits and pull requests

- Keep each pull request focused.
- Update docs (`docs/`, `README.md`) in the same pull request when behaviour or configuration changes.
- Record new design choices in `docs/decisions.md`.
