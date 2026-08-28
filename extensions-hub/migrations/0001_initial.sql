PRAGMA foreign_keys = ON;

CREATE TABLE publishers (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  publisher_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'publisher' CHECK(role IN ('publisher','reviewer','admin')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE publisher_sessions (
  id_hash TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_publisher ON publisher_sessions(publisher_id);
CREATE INDEX idx_sessions_expiry ON publisher_sessions(expires_at);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  cookie_hash TEXT NOT NULL,
  return_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('chrome','vast','hybrid')),
  homepage TEXT,
  source_url TEXT,
  icon_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','published','suspended','removed')),
  current_release_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_extensions_catalog ON extensions(status,category,updated_at);
CREATE INDEX idx_extensions_publisher ON extensions(publisher_id);
CREATE TABLE extension_owners (
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(extension_id,publisher_id)
);
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  staging_key TEXT,
  package_key TEXT,
  package_sha256 TEXT,
  package_size INTEGER,
  signature_key_id TEXT,
  descriptor_json TEXT,
  descriptor_signature TEXT,
  manifest_summary TEXT NOT NULL,
  permissions_snapshot TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','reviewing','published','rejected','changes','yanked')),
  submitted_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(extension_id,version)
);
CREATE INDEX idx_releases_review ON releases(status,submitted_at);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL UNIQUE REFERENCES releases(id) ON DELETE CASCADE,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  status TEXT NOT NULL CHECK(status IN ('pending','reviewing','approved','rejected','changes','withdrawn')),
  submitted_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE submission_reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES publishers(id),
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject','changes')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE extension_screenshots (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE categories (slug TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,position INTEGER NOT NULL);
INSERT INTO categories(slug,name,position) VALUES ('productivity','Productivity',1),('appearance','Appearance',2),('privacy','Privacy',3),('developer','Developer',4),('sidebar','Sidebar',5),('new-tab','New Tab',6),('utilities','Utilities',7),('accessibility','Accessibility',8);
CREATE TABLE download_counters (extension_id TEXT PRIMARY KEY REFERENCES extensions(id) ON DELETE CASCADE,count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY,actor_id TEXT,target_type TEXT NOT NULL,target_id TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX idx_audit_target ON audit_log(target_type,target_id,created_at);
CREATE TABLE rate_limits (bucket TEXT NOT NULL,subject_hash TEXT NOT NULL,window_start INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(bucket,subject_hash,window_start));
CREATE INDEX idx_rate_window ON rate_limits(window_start);
