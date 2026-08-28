ALTER TABLE extensions ADD COLUMN data_practice TEXT NOT NULL DEFAULT 'undisclosed'
  CHECK(data_practice IN ('undisclosed','local-only','external-processing'));
ALTER TABLE extensions ADD COLUMN privacy_policy_url TEXT;
ALTER TABLE extensions ADD COLUMN remote_services TEXT NOT NULL DEFAULT '';

CREATE TABLE publisher_terms_acceptances (
  publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  terms_sha256 TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(publisher_id,terms_version)
);

ALTER TABLE submissions ADD COLUMN warranty_version TEXT;
ALTER TABLE submissions ADD COLUMN warranty_accepted_at TEXT;

CREATE UNIQUE INDEX idx_extension_screenshots_position
  ON extension_screenshots(extension_id,position);

CREATE TABLE extension_reports (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id),
  release_id TEXT REFERENCES releases(id),
  category TEXT NOT NULL CHECK(category IN ('copyright','malware','illegal','privacy','impersonation','other')),
  details TEXT NOT NULL,
  reporter_name TEXT,
  reporter_email TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','actioned','dismissed')),
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  publisher_notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_extension_reports_review ON extension_reports(status,created_at);
CREATE INDEX idx_extension_reports_extension ON extension_reports(extension_id,created_at);

CREATE TABLE extension_report_actions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES extension_reports(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES publishers(id),
  action TEXT NOT NULL,
  internal_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_extension_report_actions ON extension_report_actions(report_id,created_at);
