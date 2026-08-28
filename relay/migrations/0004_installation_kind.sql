ALTER TABLE installations ADD COLUMN instance_kind TEXT NOT NULL DEFAULT 'unknown'
  CHECK(instance_kind IN ('packaged', 'development', 'test', 'unknown'));

CREATE INDEX installations_kind_last_seen_idx
  ON installations(instance_kind, last_seen DESC, install_id ASC);
