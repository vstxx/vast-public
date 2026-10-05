function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function summarizeIntervals(timestamps, refreshIntervalMs) {
  if (!Array.isArray(timestamps) || timestamps.length < 2) return null
  if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) throw new Error('A positive refresh interval is required')
  const times = timestamps.filter(Number.isFinite).sort((a, b) => a - b)
  if (times.length < 2) return null
  const intervals = []
  for (let index = 1; index < times.length; index += 1) {
    const interval = times[index] - times[index - 1]
    if (interval > 0) intervals.push(interval)
  }
  if (!intervals.length) return null
  intervals.sort((a, b) => a - b)
  const rounded = (value) => Math.round(value * 100) / 100
  return {
    count: intervals.length,
    p50Ms: rounded(percentile(intervals, 0.5)),
    p95Ms: rounded(percentile(intervals, 0.95)),
    p99Ms: rounded(percentile(intervals, 0.99)),
    maxMs: rounded(intervals.at(-1))
  }
}

function summarizePresentedFrames(events, refreshIntervalMs) {
  if (!Array.isArray(events)) return null
  // CDP renderer animation callbacks and compositor submissions are not evidence
  // that a frame reached the display. Only explicit presentation events qualify.
  const timestamps = events
    .filter((event) => event?.name === 'FramePresented' && Number.isFinite(event.ts))
    .map((event) => event.ts / 1000)
  return summarizeIntervals(timestamps, refreshIntervalMs)
}

function summarizeValues(values) {
  if (!values.length) return null
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const rounded = (value) => Math.round(value * 100) / 100
  return {
    count: sorted.length,
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99)),
    maxMs: rounded(sorted.at(-1))
  }
}

function summarizeScrollTrace(events, refreshIntervalMs) {
  const startsByPid = new Map()
  for (const event of events) {
    if (event?.name !== 'ScrollJankV4' || event.ph !== 'b' || !Number.isFinite(event.pid)) continue
    const starts = startsByPid.get(event.pid) || []
    starts.push(event)
    startsByPid.set(event.pid, starts)
  }
  const [rendererPid, starts] = [...startsByPid].sort((a, b) => b[1].length - a[1].length)[0] || []
  if (!starts?.length) return null
  starts.sort((a, b) => a.ts - b.ts)
  const presentations = events.filter((event) => event?.name === 'Presentation' &&
    event.pid === rendererPid && event.cat?.includes('input.scrolling') &&
    event.args?.scroll_jank_v4 && Number.isFinite(event.ts)).sort((a, b) => a.ts - b.ts)
  const displayedFrameTimes = new Set(events.filter((event) =>
    event?.name === 'Display::FrameDisplayed' && Number.isFinite(event.ts)
  ).map((event) => event.ts))
  const traceKey = (event) => {
    const id = event.id2?.local ?? event.id2?.global ?? event.id
    return id === undefined ? null : `${event.pid}:${id}`
  }
  const startsById = new Map()
  for (const start of starts) {
    const key = traceKey(start)
    if (key === null) continue
    const queue = startsById.get(key) || []
    queue.push(start)
    startsById.set(key, queue)
  }
  const latencies = []
  for (const presentation of presentations) {
    const key = traceKey(presentation)
    const start = key === null ? undefined : startsById.get(key)?.shift()
    const arrival = start?.args?.scroll_jank_v4?.updates?.scroll_begin_arrival_us
    const duration = (presentation.ts - arrival) / 1000
    if (Number.isFinite(duration) && duration >= 0) latencies.push(duration)
  }
  return {
    rendererPid,
    scrollUpdates: starts.length,
    presentedUpdates: presentations.length,
    matchedPresentations: latencies.length,
    gpuDisplayedPresentations: presentations.filter((event) => displayedFrameTimes.has(event.ts)).length,
    jankyUpdates: starts.filter((event) => event.args?.scroll_jank_v4?.is_janky === true).length,
    scrollPresentationSpacing: summarizeIntervals(presentations.map((event) => event.ts / 1000), refreshIntervalMs),
    inputToPresentationMs: summarizeValues(latencies)
  }
}

module.exports = { summarizeIntervals, summarizePresentedFrames, summarizeScrollTrace, summarizeValues }
