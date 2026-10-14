export type Range = '24h' | '7d' | '14d' | '30d' | '60d'
export type Cohort = 'packaged' | 'all' | 'development' | 'test' | 'unknown'

export interface AnalyticsResponse {
  generated_at: string
  data_source: 'measured' | 'synthetic_local'
  history_available_from: string | null
  latest_snapshot_at: string | null
  range: Range
  cohort: Cohort
  resolution_ms: number
  period: { from: string; to: string; previous_from: string }
  current: {
    active_24h: number | null
    total_installations: number | null
    active_30d: number | null
    inactive_30d: number | null
    new_installs_period: number
    launches_period: number | null
    latest_version_adoption: number | null
  }
  previous: {
    active_24h: number | null
    total_installations: number | null
    inactive_30d: number | null
    new_installs_period: number
    launches_period: number | null
    latest_version_adoption: number | null
  }
  series: Array<{ timestamp: string; active_24h: number; total_installations: number; inactive_30d: number; cumulative_launch_count: number }>
  previous_series: Array<{ timestamp: string; active_24h: number }>
  daily_new_installs: Array<{ day: string; count: number; cumulative_total: number }>
  launch_activity: {
    points: Array<{ timestamp: string; count: number | null; moving_average: number | null }>
    period_total: number | null
    biggest_spike: number | null
  }
  current_version_distribution: Array<{ version: string; count: number; percentage: number }>
  version_adoption: Array<{ version: string; points: Array<{ timestamp: string; percentage: number }> }>
  latest_release: { version: string; published_at: string | null; source: 'published' | 'observed' } | null
  changes: Array<{ kind: string; message: string; timestamp: string }>
}
