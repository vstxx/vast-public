PRAGMA foreign_keys = ON;

CREATE TABLE installations (
  install_id TEXT PRIMARY KEY NOT NULL,
  current_version TEXT NOT NULL CHECK(length(current_version) BETWEEN 5 AND 64),
  first_seen INTEGER NOT NULL CHECK(first_seen >= 0),
  last_seen INTEGER NOT NULL CHECK(last_seen >= first_seen),
  launch_count INTEGER NOT NULL CHECK(launch_count BETWEEN 0 AND 2147483647)
) STRICT;

CREATE INDEX installations_last_seen_idx ON installations(last_seen);
CREATE INDEX installations_current_version_idx ON installations(current_version);

CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/webp', 'image/gif')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 2097152),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

CREATE TABLE broadcasts (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('welcome', 'seasonal', 'announcement', 'security', 'update_notice')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  action_label TEXT,
  action_url TEXT,
  min_version TEXT,
  max_version TEXT,
  active_from INTEGER NOT NULL CHECK(active_from >= 0),
  active_until INTEGER CHECK(active_until IS NULL OR active_until > active_from),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 1000),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  canonical_payload TEXT NOT NULL CHECK(length(canonical_payload) BETWEEN 2 AND 16384),
  signature TEXT NOT NULL CHECK(length(signature) = 88),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 80),
  CHECK((action_label IS NULL AND action_url IS NULL) OR (action_label IS NOT NULL AND action_url IS NOT NULL))
) STRICT;

CREATE INDEX broadcasts_delivery_idx
  ON broadcasts(enabled, active_from, active_until, priority DESC);
CREATE INDEX broadcasts_asset_idx ON broadcasts(asset_id);

CREATE TABLE releases (
  version TEXT PRIMARY KEY NOT NULL CHECK(length(version) BETWEEN 5 AND 64),
  release_url TEXT NOT NULL CHECK(length(release_url) BETWEEN 9 AND 2048),
  severity TEXT NOT NULL CHECK(severity IN ('optional', 'recommended', 'important', 'critical')),
  min_supported_version TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  notes TEXT NOT NULL CHECK(length(notes) BETWEEN 1 AND 2000),
  published_at INTEGER NOT NULL CHECK(published_at >= 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  canonical_payload TEXT NOT NULL CHECK(length(canonical_payload) BETWEEN 2 AND 8192),
  signature TEXT NOT NULL CHECK(length(signature) = 88),
  key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 80)
) STRICT;

CREATE INDEX releases_delivery_idx ON releases(enabled, published_at DESC);

CREATE TABLE admin_audit (
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

CREATE INDEX admin_audit_occurred_at_idx ON admin_audit(occurred_at DESC);
