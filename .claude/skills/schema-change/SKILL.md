---
name: schema-change
description: Change the database schema safely — generate a sequelize migration, update the model, keep app isolation and indexes right, migrate dev and test DBs, and update docs. Use when adding/removing/renaming columns, tables or indexes.
---

# Change the schema

1. **Generate:** `npx sequelize-cli migration:generate --name <verb-object>`. It lands in `src/db/migrations/`. Never hand-write the timestamp.
2. **Write `up` and `down`** inside `queryInterface.sequelize.transaction(...)`.
   - Name every index.
   - App-facing tables carry `app_id`, and their indexes start with it.
   - Raw SQL needs a `// raw because:` comment (e.g. `NULLS NOT DISTINCT`, `DESC` index columns).
3. **Released schema** (anything deployed): expand → migrate → contract.
   - Never drop or rename a column that running code reads.
   - Backfills are batched and resumable.
4. **Model:** update `src/db/models/<name>.model.js` in the same change: camelCase attributes, statuses validated against the frozen constants.
5. **Repositories and services:** extend `attributes` lists, and keep `requireAppId` on app-facing methods.
6. **Migrate:** `npm run db:migrate && npm run db:migrate:test`. Prove the reverse path with `npm run db:migrate:undo` then migrate again.
7. **Test:** extend `test/helpers/db.js` `TABLES` for new tables, then run `npm run check`.
8. **Document:** the data model in `docs/architecture.md` §6.
