PRAGMA foreign_keys = ON;

CREATE INDEX installations_first_seen_idx ON installations(first_seen);
CREATE INDEX assets_created_at_idx ON assets(created_at DESC);

ALTER TABLE broadcasts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE broadcasts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0 CHECK(updated_at >= 0);
ALTER TABLE broadcasts ADD COLUMN draft INTEGER NOT NULL DEFAULT 0 CHECK(draft IN (0, 1));
UPDATE broadcasts SET updated_at = created_at WHERE updated_at = 0;

ALTER TABLE releases ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE releases ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0 CHECK(updated_at >= 0);
UPDATE releases SET updated_at = published_at WHERE updated_at = 0;

CREATE TABLE admin_audit_v2 (
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
    'release_enabled',
    'release_disabled',
    'release_deleted'
  )),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('broadcast', 'asset', 'release')),
  entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 100),
  actor TEXT NOT NULL DEFAULT 'phase1-legacy' CHECK(length(actor) BETWEEN 3 AND 254),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(length(summary_json) BETWEEN 2 AND 2048 AND json_valid(summary_json)),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
) STRICT;

INSERT INTO admin_audit_v2 (id, event_type, entity_type, entity_id, actor, summary_json, occurred_at)
SELECT id, event_type, entity_type, entity_id, 'phase1-legacy', '{}', occurred_at
FROM admin_audit;

DROP TABLE admin_audit;
ALTER TABLE admin_audit_v2 RENAME TO admin_audit;

CREATE INDEX admin_audit_occurred_at_idx ON admin_audit(occurred_at DESC);
CREATE INDEX admin_audit_entity_idx ON admin_audit(entity_type, entity_id, occurred_at DESC);
