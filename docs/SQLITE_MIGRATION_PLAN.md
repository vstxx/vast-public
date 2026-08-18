# SQLite Migration Plan

Vast 1.0.9 keeps JSON storage as the compatible runtime format. Do not delete or rewrite existing user data for a storage migration.

SQLite is the planned target for high-volume or query-heavy data:

- history
- downloads
- notes
- session snapshots
- site permissions
- site memory and site data summaries

Migration constraints:

- Keep JSON export/recovery available before and after any migration.
- Back up the active JSON file before the first SQLite write.
- Use additive tables and preserve unknown JSON fields until a deliberate schema owner removes them.
- Keep private workspace history and captured login rules intact.
- Add tests for idempotent migration, rollback on failed migration, and import/export compatibility.

The existing `src/main/storage-adapter.ts` placeholder remains a future migration point. No SQLite runtime migration is enabled in this pass.
