CREATE INDEX installations_last_seen_install_id_idx
  ON installations(last_seen DESC, install_id ASC);

CREATE INDEX installations_version_last_seen_idx
  ON installations(current_version, last_seen DESC, install_id ASC);
