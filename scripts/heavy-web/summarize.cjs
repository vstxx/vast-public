#!/usr/bin/env node
// Medians per scenario and target across repetitions of bench.cjs results.
// Usage: node scripts/heavy-web/summarize.cjs <results.json> [<more.json>...]
const fs = require('node:fs')

const median = (values) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const middle = Math.floor(list.length / 2)
  return +(list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2).toFixed(2)
}
const sum = (object) => object ? Object.values(object).reduce((total, value) => total + value, 0) : null

const results = process.argv.slice(2).flatMap((file) => JSON.parse(fs.readFileSync(file, 'utf8')).results)
const groups = new Map()
for (const result of results) {
  if (result.error) continue
  const key = `${result.scenario}|${result.target}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(result)
}
const rows = []
for (const [key, runs] of groups) {
  const [scenario, target] = key.split('|')
  const swaps = (run) => run.trace ? Math.max(0, ...Object.entries(run.trace.displaySwapsPerSecond).filter(([name]) => name.startsWith('GPU')).map(([, value]) => value)) : null
  const presented = (run) => {
    if (!run.trace) return null
    let presentedFrames = 0
    let dropped = 0
    for (const [name, states] of Object.entries(run.trace.pipelineByProcess)) {
      if (!name.startsWith('Renderer')) continue
      presentedFrames += (states.STATE_PRESENTED_ALL || 0) + (states.STATE_PRESENTED_PARTIAL || 0)
      dropped += states.STATE_DROPPED || 0
    }
    return presentedFrames + dropped ? +(100 * dropped / (presentedFrames + dropped)).toFixed(2) : null
  }
  rows.push({
    scenario, target, n: runs.length,
    fps: median(runs.map((run) => run.frames?.fps)), p95: median(runs.map((run) => run.frames?.p95)), p99: median(runs.map((run) => run.frames?.p99)),
    missedVsyncPct: median(runs.map((run) => run.frames?.missedVsyncPercent)), longFrames: median(runs.map((run) => run.frames?.longFramesOver2Vsync)),
    displaySwapsPerS: median(runs.map(swaps)), droppedPct: median(runs.map(presented)),
    cpuPct: median(runs.map((run) => run.resources?.totalCpuPercentOfOneCore)), gpu3dPct: median(runs.map((run) => sum(run.resources?.gpuEngineBusyPercent))),
    privateMB: median(runs.map((run) => run.resources?.privateMB)),
    hostBusyPct: median(runs.map((run) => run.host?.mainThreadBusyPercent)), hostLayoutsPerS: median(runs.map((run) => run.host?.layoutsPerSecond)),
    saves: median(runs.map((run) => run.main?.storageWrites)), saveMs: median(runs.map((run) => run.main?.storageWriteMs)),
    mainEldP99: median(runs.map((run) => run.main?.mainEventLoopDelayP99Ms)),
    inputP95: median(runs.map((run) => run.input?.durationP95)),
    workersMs: median(runs.flatMap((run) => run.workers?.map((job) => job.elapsedMs) || [])),
    tilesRps: median(runs.flatMap((run) => run.tiles?.map((job) => job.requestsPerSecond) || [])),
    historyAfter: runs.map((run) => run.history && `${run.history.fromFixture}/${run.history.entries}`).filter(Boolean).join(' ') || null
  })
}
rows.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.target.localeCompare(b.target))
const columns = Object.keys(rows[0] || {}).filter((column) => rows.some((row) => row[column] !== null && row[column] !== undefined))
console.log(columns.join('\t'))
for (const row of rows) console.log(columns.map((column) => row[column] ?? '').join('\t'))
