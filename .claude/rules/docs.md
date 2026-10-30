---
paths:
  - "docs/**"
  - "*.md"
---

# Documentation rules

- **Docs describe the code as it is.** A change in behaviour, API, config or deployment updates the matching doc in the same change:

| Change | Doc |
|---|---|
| Endpoint, envelope, error code, stream, webhook | `docs/api.md` |
| Config key or env var | `npm run docs:config` (regenerates the tables in `docs/configuration.md`; never edit those tables by hand) |
| Runner, image, secret, ops procedure | `docs/deployment.md` |
| Lifecycle, isolation, data model | `docs/architecture.md` |
| A design choice and why | a new `D<n>` entry in `docs/decisions.md` (never renumber old ones) |
| Something observed from the `claude` CLI | `docs/claude-code-behavior.md`, with a fixture when possible |
| Cost, budgets, credential profiles | `docs/costs.md` |
| Done or planned work | `docs/roadmap.md` |

- **Never claim more than exists:** planned features are marked in the roadmap, not described as working.
- **Examples must run:** every command and curl in the docs works against the current code.
- **No personal data:** no user paths, emails, tokens, internal hostnames or company-only details. Use `example.com`, `<owner>/<repo>`, `gwk_…`.
- **Keep it short:** one fact in one place, and link instead of repeating. `README.md` stays an overview with links.
- **Subscription use:** state Anthropic's terms neutrally and link to them; never suggest working around plan limits.
