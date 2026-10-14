import { barLineChart, lineChart, sparkline, type Point } from './charts'
import type { AnalyticsResponse, Cohort, Range } from './types'

const ranges: Range[] = ['24h', '7d', '14d', '30d', '60d']
const cohorts: Array<[Cohort, string]> = [['packaged', 'Packaged'], ['all', 'All'], ['development', 'Development'], ['test', 'Test'], ['unknown', 'Unknown']]

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  if (className) result.className = className
  if (content !== undefined) result.textContent = content
  return result
}
function num(value: number | null, suffix = ''): string { return value === null ? '—' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}` }
function time(value: string): number { return Date.parse(value) }
function formatTime(value: string): string { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function periodLabel(range: Range): string { return range === '24h' ? 'previous 24 hours' : `previous ${range.slice(0, -1)} days` }
function points<T>(rows: T[], key: keyof T, timeKey: keyof T = 'timestamp' as keyof T): Point[] {
  return rows.map((row) => ({ time: time(String(row[timeKey])), value: row[key] === null ? null : Number(row[key]) }))
}
function comparison(current: number | null, previous: number | null, goodDirection: 1 | -1, range: Range, unit: 'percent' | 'pp' = 'percent'): HTMLElement {
  const result = node('span', 'analytics-delta')
  if (current === null || previous === null || (unit === 'percent' && previous === 0)) {
    result.textContent = 'Comparison unavailable'
    return result
  }
  const change = unit === 'pp' ? current - previous : (current - previous) / previous * 100
  const rounded = Math.round(change * 10) / 10
  result.textContent = `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}${unit === 'pp' ? ' pp' : '%'} vs ${periodLabel(range)}`
  result.classList.add(rounded * goodDirection > 0 ? 'analytics-delta--good' : rounded * goodDirection < 0 ? 'analytics-delta--bad' : 'analytics-delta--flat')
  return result
}

function metric(label: string, value: number | null, previous: number | null, trend: Point[], goodDirection: 1 | -1, range: Range, explanation: string, maxGap: number, suffix = '', unit: 'percent' | 'pp' = 'percent'): HTMLElement {
  const card = node('article', 'analytics-metric')
  const heading = node('div', 'analytics-metric__heading')
  const title = node('span', undefined, label)
  title.title = explanation
  heading.append(title, node('span', 'analytics-metric__help', '?'))
  heading.lastElementChild?.setAttribute('title', explanation)
  const valueNode = node('strong', 'analytics-metric__value', num(value, suffix))
  const delta = comparison(value, previous, goodDirection, range, unit)
  card.append(heading, valueNode, delta, sparkline(trend, maxGap))
  return card
}

function panel(title: string, description?: string): HTMLElement {
  const element = node('section', 'analytics-panel')
  const header = node('div', 'analytics-panel__head')
  header.append(node('h2', undefined, title))
  if (description) header.append(node('p', undefined, description))
  element.append(header)
  return element
}

export function renderOverview(
  data: AnalyticsResponse,
  environment: string,
  onSelect: (range: Range, cohort: Cohort) => void,
  onRefresh: () => void
): { element: HTMLElement; updateAge: () => void } {
  const root = node('div', 'analytics-overview')
  const header = node('header', 'analytics-header')
  const heading = node('div')
  const titleLine = node('div', 'analytics-title-line')
  titleLine.append(node('h1', undefined, 'Overview'), node('span', 'analytics-environment', environment.toUpperCase()))
  const snapshot = node('p', 'analytics-subtitle', data.latest_snapshot_at ? `Latest snapshot ${formatTime(data.latest_snapshot_at)}` : 'No analytics snapshot collected yet')
  heading.append(titleLine, snapshot)
  const refreshSide = node('div', 'analytics-refresh')
  const refreshStatus = node('span', undefined, 'Automatic refresh · every 30s')
  const age = node('span', 'analytics-age')
  const updateAge = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - time(data.generated_at)) / 1000))
    age.textContent = `Updated ${elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`} ago`
  }
  updateAge()
  const refresh = node('button', 'analytics-refresh-button', 'Refresh')
  refresh.type = 'button'
  refresh.addEventListener('click', onRefresh)
  refreshSide.append(refreshStatus, age, refresh)
  header.append(heading, refreshSide)
  root.append(header)

  const toolbar = node('div', 'analytics-toolbar')
  const rangeGroup = node('div', 'analytics-segments')
  rangeGroup.setAttribute('aria-label', 'Analytics range')
  for (const range of ranges) {
    const button = node('button', range === data.range ? 'is-selected' : '', range.toUpperCase())
    button.type = 'button'
    button.setAttribute('aria-pressed', String(range === data.range))
    button.addEventListener('click', () => onSelect(range, data.cohort))
    rangeGroup.append(button)
  }
  const cohortGroup = node('div', 'analytics-segments')
  cohortGroup.setAttribute('aria-label', 'Installation cohort')
  for (const [cohort, label] of cohorts) {
    const button = node('button', cohort === data.cohort ? 'is-selected' : '', label)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(cohort === data.cohort))
    button.addEventListener('click', () => onSelect(data.range, cohort))
    cohortGroup.append(button)
  }
  toolbar.append(rangeGroup, cohortGroup)
  root.append(toolbar)

  if (data.data_source === 'synthetic_local') root.append(node('div', 'analytics-synthetic-note', 'LOCAL DEMO DATA · Synthetic installation and snapshot values. Never use for operational decisions.'))

  if (!data.history_available_from || time(data.history_available_from) > time(data.period.from)) {
    const notice = node('div', 'analytics-history-note', data.history_available_from
      ? `Snapshot history available since ${new Date(data.history_available_from).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. Earlier activity, launch, and version history is unavailable.`
      : 'Snapshot history has not started. Historical new installs and cumulative installations are reconstructed from first seen timestamps.')
    root.append(notice)
  }

  const active = points(data.series, 'active_24h')
  const total = points(data.series, 'total_installations')
  const inactive = points(data.series, 'inactive_30d')
  const newInstalls = points(data.daily_new_installs, 'count', 'day')
  const launches = points(data.launch_activity.points, 'count')
  const adoption = data.latest_release ? data.version_adoption.find((item) => item.version === data.latest_release?.version) : null
  const adoptionPoints = adoption ? points(adoption.points, 'percentage') : []
  const metrics = node('section', 'analytics-metrics')
  metrics.append(
    metric('Active 24h', data.current.active_24h, data.previous.active_24h, active, 1, data.range, 'Installations whose last check-in was within 24 hours of the snapshot.', data.resolution_ms * 1.5),
    metric('Total installations', data.current.total_installations, data.previous.total_installations, total, 1, data.range, 'Known installations in this cohort at the latest snapshot.', data.resolution_ms * 1.5),
    metric('New installs', data.current.new_installs_period, data.previous.new_installs_period, newInstalls, 1, data.range, 'Installations first seen during the selected period. Reconstructed from the registry.', 86_400_000 * 1.5),
    metric('Launches', data.current.launches_period, data.previous.launches_period, launches, 1, data.range, 'Sum of valid increases in cumulative launch count. Unavailable when snapshot coverage is incomplete.', data.resolution_ms * 1.5),
    metric('Latest-version adoption', data.current.latest_version_adoption, data.previous.latest_version_adoption, adoptionPoints, 1, data.range, 'Share of this cohort on the latest published release, or highest observed version when no release is published.', data.resolution_ms * 1.5, '%', 'pp'),
    metric('Inactive 30d', data.current.inactive_30d, data.previous.inactive_30d, inactive, -1, data.range, 'Known installations with no check-in in the 30 days before the snapshot.', data.resolution_ms * 1.5)
  )
  root.append(metrics)

  const from = time(data.period.from), to = time(data.period.to)
  const duration = to - from
  const activityPanel = panel('Active installations', 'Installations seen in the preceding 24 hours · measured at each snapshot')
  const previous = data.previous_series.map((item) => ({ time: time(item.timestamp) + duration, originalTime: time(item.timestamp), value: item.active_24h }))
  activityPanel.append(lineChart({
    label: 'Active 24 hour installations over time', from, to, maxGap: data.resolution_ms * 1.5,
    series: [
      { name: 'Previous period', points: previous, color: 'rgba(184,108,255,.45)', dashed: true },
      { name: 'Current period', points: active, color: '#74e7ff' }
    ]
  }))
  const activityFooter = node('div', 'analytics-chart-footer')
  const measured = active.map((point) => point.value).filter((value): value is number => value !== null)
  activityFooter.append(node('span', undefined, measured.length ? `Measured min ${num(Math.min(...measured))} · max ${num(Math.max(...measured))}` : 'No measured activity history in this range'))
  activityFooter.append(node('span', undefined, 'Cyan current · dashed purple previous'))
  activityPanel.append(activityFooter)
  root.append(activityPanel)

  const lower = node('div', 'analytics-two-column')
  const growth = panel('Installation growth', 'UTC calendar days · first seen timestamps')
  const dailyBars = points(data.daily_new_installs, 'count', 'day')
  const cumulative = points(data.daily_new_installs, 'cumulative_total', 'day')
  growth.append(barLineChart({ label: 'New installations by day and cumulative installations', bars: dailyBars, line: cumulative,
    from: dailyBars[0]?.time ?? from, to: Math.max(to, dailyBars.at(-1)?.time ?? to), barLabel: 'new', lineLabel: 'cumulative' }))
  growth.append(node('p', 'analytics-legend', 'Cyan bars · new per day     Purple line · cumulative total'))
  const launch = panel('Launch activity', 'Valid changes in cumulative launch count between consecutive snapshots')
  if (launches.some((point) => point.value !== null)) {
    launch.append(barLineChart({ label: 'Measured launches and moving average', bars: launches,
      line: points(data.launch_activity.points, 'moving_average'), from, to, barLabel: 'launches', lineLabel: '4 interval average' }))
  } else launch.append(node('div', 'analytics-empty-chart', 'Launch history begins after two consecutive valid snapshots.'))
  const launchFooter = node('p', 'analytics-legend', `Period total ${num(data.launch_activity.period_total)} · biggest measured interval ${num(data.launch_activity.biggest_spike)}`)
  launch.append(launchFooter)
  lower.append(growth, launch)
  root.append(lower)

  const version = panel('Version adoption', data.latest_release ? `Latest ${data.latest_release.source} version · ${data.latest_release.version}` : 'No observed version yet')
  const versionGrid = node('div', 'analytics-version-grid')
  const versionList = node('div', 'analytics-version-list')
  const versionColors = ['#74e7ff', '#b86cff', '#9a9cff', '#7383a5', '#69717e']
  if (!data.current_version_distribution.length) versionList.append(node('p', 'analytics-muted', 'Version distribution starts with the first snapshot.'))
  for (const item of data.current_version_distribution.slice(0, 8)) {
    const row = node('div', 'analytics-version-row')
    const labels = node('div', 'analytics-version-row__labels')
    labels.append(node('strong', undefined, item.version), node('span', undefined, `${num(item.percentage, '%')} · ${num(item.count)}`))
    const track = node('div', 'analytics-version-track')
    const fill = node('span')
    fill.style.width = `${Math.max(0, Math.min(100, item.percentage))}%`
    fill.style.background = versionColors[data.version_adoption.findIndex((series) => series.version === item.version)] ?? '#7383a5'
    track.append(fill)
    row.append(labels, track)
    versionList.append(row)
  }
  const adoptionChart = data.version_adoption.some((item) => item.points.length)
    ? lineChart({ label: 'Measured version adoption over time', from, to, min: 0, max: 100, unit: '%', height: 250, maxGap: data.resolution_ms * 1.5,
      series: data.version_adoption.map((item, index) => ({ name: item.version, points: points(item.points, 'percentage'), color: versionColors[index] })) })
    : node('div', 'analytics-empty-chart', 'Version adoption history begins with snapshots.')
  versionGrid.append(versionList, adoptionChart)
  version.append(versionGrid)
  root.append(version)

  const changes = panel('Changes', data.data_source === 'synthetic_local' ? 'Deterministic signals from local demo data' : 'Deterministic signals from measured data')
  if (!data.changes.length) changes.append(node('p', 'analytics-muted', 'No meaningful changes detected in the available history.'))
  else {
    const list = node('ul', 'analytics-changes')
    for (const item of data.changes) {
      const entry = node('li')
      entry.append(node('span', undefined, item.message), node('time', undefined, formatTime(item.timestamp)))
      list.append(entry)
    }
    changes.append(list)
  }
  root.append(changes)
  return { element: root, updateAge }
}
