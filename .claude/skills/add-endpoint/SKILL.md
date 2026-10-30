---
name: add-endpoint
description: Add or change an HTTP endpoint of the gateway API following the layered architecture (route → validator → controller → service → repository) with auth, scopes, app isolation, envelope, tests and docs. Use for any new or modified /api/v1 route.
---

# Add an API endpoint

Read `.claude/rules/backend.md` §4, §7, §12 and §13 first.

1. **Route** in `src/api/routes/index.js`: put it after `authenticate`, with `requireScope(SCOPES.…)`, plus `requireFeature(FEATURES.…)` if it's new behaviour. New features are off by default; add the flag to `src/constants/features.js`.
2. **Validator** in `src/api/validators/<resource>.validator.js`:
   - `onlyFields([...])` and UUID path params.
   - Bounds from `config.get()`.
   - Messages formatted as `Human Name (field) constraint`.
3. **Controller** in `src/api/controllers/<resource>.controller.js`: validate, call **one** service function, respond with `new Response(true, message, data, req.context.requestId)`, `return next(error)`. No DB access, no logic.
4. **Service** in `src/services/`:
   - Business rules and typed errors (`src/utils/AppError.js`).
   - `withTransaction` for multi-step writes, with no I/O inside.
   - Return shaped plain objects, never model instances.
5. **Repository:** app-facing methods take `appId` and call `requireAppId`. Use `findOne({ where: { id, appId } })`, explicit `attributes`, a deterministic `order`.
6. **Tests** in `test/integration/api.test.js` or a new file:
   - the happy path
   - validation
   - the wrong scope (403)
   - **another app gets 404**
   - the flag off (404)
7. **Docs:** add the route to `docs/api.md`. New config keys need `npm run docs:config`.
8. **Finish:** `npm run check` must be green.
