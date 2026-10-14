CREATE TABLE analytics_metric_snapshots (
  bucket_ts INTEGER NOT NULL CHECK(bucket_ts >= 0 AND bucket_ts % 900000 = 0),
  cohort TEXT NOT NULL CHECK(cohort IN ('all', 'packaged', 'development', 'test', 'unknown')),
  collected_at INTEGER NOT NULL CHECK(collected_at >= bucket_ts),
  source TEXT NOT NULL DEFAULT 'measured' CHECK(source IN ('measured', 'synthetic_local')),
  total_installations INTEGER NOT NULL CHECK(total_installations >= 0),
  active_24h INTEGER NOT NULL CHECK(active_24h >= 0),
  active_7d INTEGER NOT NULL CHECK(active_7d >= 0),
  active_30d INTEGER NOT NULL CHECK(active_30d >= 0),
  new_24h INTEGER NOT NULL CHECK(new_24h >= 0),
  new_7d INTEGER NOT NULL CHECK(new_7d >= 0),
  new_30d INTEGER NOT NULL CHECK(new_30d >= 0),
  cumulative_launch_count INTEGER NOT NULL CHECK(cumulative_launch_count >= 0),
  average_launch_count REAL NOT NULL CHECK(average_launch_count >= 0),
  maximum_launch_count INTEGER NOT NULL CHECK(maximum_launch_count >= 0),
  PRIMARY KEY (bucket_ts, cohort)
) STRICT;

CREATE INDEX analytics_metric_cohort_time_idx
  ON analytics_metric_snapshots(cohort, bucket_ts DESC);
CREATE INDEX analytics_metric_source_idx
  ON analytics_metric_snapshots(source, bucket_ts DESC);

CREATE TABLE analytics_version_snapshots (
  bucket_ts INTEGER NOT NULL CHECK(bucket_ts >= 0 AND bucket_ts % 900000 = 0),
  cohort TEXT NOT NULL CHECK(cohort IN ('all', 'packaged', 'development', 'test', 'unknown')),
  version TEXT NOT NULL CHECK(length(version) BETWEEN 5 AND 64),
  installation_count INTEGER NOT NULL CHECK(installation_count > 0),
  PRIMARY KEY (bucket_ts, cohort, version)
) STRICT;

CREATE INDEX analytics_version_cohort_version_time_idx
  ON analytics_version_snapshots(cohort, version, bucket_ts DESC);
