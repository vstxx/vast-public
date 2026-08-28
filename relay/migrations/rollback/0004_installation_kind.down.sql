-- Disposable local/staging rollback reference only.
-- Production rollback must use a D1 Time Travel bookmark or pre-migration export.
DROP INDEX IF EXISTS installations_kind_last_seen_idx;

-- Column removal is intentionally omitted. Restoring the pre-migration database
-- is the only supported production rollback that preserves installation data.
