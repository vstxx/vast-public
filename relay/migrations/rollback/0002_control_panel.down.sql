-- Disposable local/staging rollback reference only.
-- Production rollback must use a D1 Time Travel bookmark or pre-migration export.
PRAGMA foreign_keys = ON;

DROP INDEX IF EXISTS installations_first_seen_idx;
DROP INDEX IF EXISTS assets_created_at_idx;
DROP INDEX IF EXISTS admin_audit_entity_idx;

CREATE TABLE admin_audit_phase1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'broadcast_created',
    'broadcast_updated',
    'broadcast_enabled',
    'broadcast_disabled',
    'broadcast_deleted',
    'asset_uploaded',
    'asset_deleted',
    'release_created',
    'release_updated',
    'release_deleted'
  )),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('broadcast', 'asset', 'release')),
  entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 100),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
) STRICT;

INSERT INTO admin_audit_phase1 (id, event_type, entity_type, entity_id, occurred_at)
SELECT id, event_type, entity_type, entity_id, occurred_at
FROM admin_audit
WHERE event_type NOT IN ('release_enabled', 'release_disabled');

DROP TABLE admin_audit;
ALTER TABLE admin_audit_phase1 RENAME TO admin_audit;
CREATE INDEX admin_audit_occurred_at_idx ON admin_audit(occurred_at DESC);

-- SQLite/D1 column removal is intentionally omitted here. Restoring the
-- pre-migration database is the only supported production rollback because it
-- preserves the canonical payload/signature data atomically.
