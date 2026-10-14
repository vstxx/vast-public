const NS = 'http://www.w3.org/2000/svg'

export interface Point { time: number; value: number | null; originalTime?: number }
export interface Series { name: string; points: Point[]; color: string; dashed?: boolean }

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

function path(points: Point[], x: (time: number) => number, y: (value: number) => number, maxGap: number): string {
  let result = ''
  let lastTime: number | null = null
  for (const point of points) {
    if (point.value === null) { lastTime = null; continue }
    result += `${lastTime === null || point.time - lastTime > maxGap ? 'M' : 'L'}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)} `
    lastTime = point.time
  }
  return result.trim()
}

export function lineChart(options: {
  label: string; from: number; to: number; series: Series[]; maxGap: number;
  unit?: string; height?: number; min?: number; max?: number
}): HTMLElement {
  const width = 1000
  const height = options.height ?? 290
  const top = 24
  const bottom = height - 32
  const left = 42
  const right = width - 16
  const values = options.series.flatMap((series) => series.points.map((point) => point.value)).filter((value): value is number => value !== null)
  const minimum = options.min ?? (values.length ? Math.min(...values) : 0)
  const maximum = options.max ?? (values.length ? Math.max(...values) : 1)
  const spread = Math.max(1, maximum - minimum)
  const paddedMin = options.min ?? Math.max(0, minimum - spread * 0.12)
  const paddedMax = options.max ?? (maximum + spread * 0.12)
  const x = (time: number) => left + (time - options.from) / Math.max(1, options.to - options.from) * (right - left)
  const y = (value: number) => bottom - (value - paddedMin) / Math.max(1, paddedMax - paddedMin) * (bottom - top)
  const wrap = document.createElement('div')
  wrap.className = 'analytics-chart'
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.label, preserveAspectRatio: 'none' })
  for (let tick = 0; tick <= 4; tick++) {
    const value = paddedMin + (paddedMax - paddedMin) * (1 - tick / 4)
    const py = top + (bottom - top) * tick / 4
    svg.append(svgNode('line', { x1: String(left), y1: String(py), x2: String(right), y2: String(py), class: 'analytics-grid-line' }))
    const text = svgNode('text', { x: '34', y: String(py + 4), class: 'analytics-axis-label', 'text-anchor': 'end' })
    text.textContent = `${Math.round(value)}${options.unit ?? ''}`
    svg.append(text)
  }
  for (let tick = 0; tick <= 4; tick++) {
    const timestamp = options.from + (options.to - options.from) * tick / 4
    const label = svgNode('text', { x: String(x(timestamp)), y: String(height - 5), class: 'analytics-axis-label', 'text-anchor': tick === 0 ? 'start' : tick === 4 ? 'end' : 'middle' })
    label.textContent = new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(options.to - options.from <= 2 * 86_400_000 ? { hour: '2-digit' as const } : {}) })
    svg.append(label)
  }
  for (const series of options.series) {
    svg.append(svgNode('path', {
      d: path(series.points, x, y, options.maxGap), fill: 'none', stroke: series.color,
      'stroke-width': series.dashed ? '2' : '2.5', 'stroke-dasharray': series.dashed ? '5 6' : '',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'analytics-line'
    }))
  }
  const cursor = svgNode('line', { y1: String(top), y2: String(bottom), class: 'analytics-cursor' })
  cursor.style.display = 'none'
  svg.append(cursor)
  const tip = document.createElement('div')
  tip.className = 'analytics-tooltip'
  tip.hidden = true
  const available = options.series.flatMap((series) => series.points.filter((point) => point.value !== null))
  svg.addEventListener('pointermove', (event) => {
    if (!available.length) return
    const rect = svg.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const target = options.from + ratio * (options.to - options.from)
    const nearest = available.reduce((best, point) => Math.abs(point.time - target) < Math.abs(best.time - target) ? point : best)
    cursor.setAttribute('x1', String(x(nearest.time)))
    cursor.setAttribute('x2', String(x(nearest.time)))
    cursor.style.display = ''
    const details = options.series.flatMap((series) => {
      const candidates = series.points.filter((point) => point.value !== null)
      if (!candidates.length) return []
      const point = candidates.reduce((best, item) => Math.abs(item.time - nearest.time) < Math.abs(best.time - nearest.time) ? item : best)
      if (Math.abs(point.time - nearest.time) > options.maxGap / 2) return []
      const original = point.originalTime && point.originalTime !== point.time ? ` (${new Date(point.originalTime).toLocaleDateString()})` : ''
      return [`${series.name}: ${point.value?.toLocaleString()}${options.unit ?? ''}${original}`]
    })
    tip.textContent = `${new Date(nearest.time).toLocaleString()}\n${details.join('\n')}`
    tip.hidden = false
    tip.style.left = `${Math.max(0, Math.min(rect.width - 185, event.clientX - rect.left + 12))}px`
  })
  svg.addEventListener('pointerleave', () => { cursor.style.display = 'none'; tip.hidden = true })
  wrap.append(svg, tip)
  return wrap
}

export function sparkline(points: Point[], maxGap: number, color = 'var(--vast-accent)'): SVGSVGElement {
  const svg = svgNode('svg', { viewBox: '0 0 100 24', role: 'img', 'aria-label': 'Measured trend', preserveAspectRatio: 'none', class: 'analytics-sparkline' })
  const valid = points.filter((point) => point.value !== null)
  if (valid.length < 2) return svg
  const values = valid.map((point) => point.value as number)
  const min = Math.min(...values), max = Math.max(...values)
  const from = valid[0].time, to = valid.at(-1)!.time
  svg.append(svgNode('path', {
    d: path(points, (time) => (time - from) / Math.max(1, to - from) * 100, (value) => 22 - (value - min) / Math.max(1, max - min) * 20, maxGap),
    fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round'
  }))
  return svg
}

export function barLineChart(options: { label: string; bars: Point[]; line: Point[]; from: number; to: number; barLabel: string; lineLabel: string }): HTMLElement {
  const width = 1000, height = 265, top = 20, bottom = 226, left = 42, right = 984
  const maxBars = Math.max(1, ...options.bars.map((point) => point.value ?? 0))
  const lineValues = options.line.map((point) => point.value).filter((value): value is number => value !== null)
  const lineMin = Math.min(0, ...lineValues), lineMax = Math.max(1, ...lineValues)
  const x = (time: number) => left + (time - options.from) / Math.max(1, options.to - options.from) * (right - left)
  const barY = (value: number) => bottom - value / maxBars * (bottom - top)
  const lineY = (value: number) => bottom - (value - lineMin) / Math.max(1, lineMax - lineMin) * (bottom - top)
  const wrap = document.createElement('div')
  wrap.className = 'analytics-chart'
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.label, preserveAspectRatio: 'none' })
  for (let tick = 0; tick <= 4; tick++) {
    const py = top + (bottom - top) * tick / 4
    svg.append(svgNode('line', { x1: String(left), x2: String(right), y1: String(py), y2: String(py), class: 'analytics-grid-line' }))
  }
  const barWidth = Math.max(3, Math.min(24, (right - left) / Math.max(1, options.bars.length) * 0.62))
  for (const point of options.bars) {
    if (point.value === null) continue
    const rect = svgNode('rect', { x: String(x(point.time) - barWidth / 2), y: String(barY(point.value)), width: String(barWidth), height: String(bottom - barY(point.value)), class: 'analytics-bar' })
    const title = svgNode('title')
    title.textContent = `${new Date(point.time).toLocaleDateString()}: ${point.value.toLocaleString()} ${options.barLabel}`
    rect.append(title)
    svg.append(rect)
  }
  svg.append(svgNode('path', { d: path(options.line, x, lineY, (options.to - options.from) / Math.max(1, options.line.length) * 1.6), fill: 'none', stroke: '#b86cff', 'stroke-width': '2.5', 'stroke-linejoin': 'round', class: 'analytics-line' }))
  for (const point of options.line) {
    if (point.value === null) continue
    const circle = svgNode('circle', { cx: String(x(point.time)), cy: String(lineY(point.value)), r: '5', fill: 'transparent' })
    const title = svgNode('title')
    title.textContent = `${new Date(point.time).toLocaleDateString()}: ${point.value.toLocaleString()} ${options.lineLabel}`
    circle.append(title)
    svg.append(circle)
  }
  wrap.append(svg)
  return wrap
}
