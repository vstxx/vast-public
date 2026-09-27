ALTER TABLE extensions ADD COLUMN attribution_name TEXT;
ALTER TABLE extensions ADD COLUMN attribution_url TEXT;
ALTER TABLE extensions ADD COLUMN license_spdx TEXT;
ALTER TABLE extensions ADD COLUMN source_ref TEXT;
INSERT OR IGNORE INTO categories(slug,name,position) VALUES ('password-managers','Password Managers',9);
