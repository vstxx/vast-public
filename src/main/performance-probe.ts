import { ipcMain } from 'electron/main'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

type PerformanceMark = {
  name: string
  atEpochMs: number
  sinceProbeStartMs: number
  detail?: Record<string, string | number | boolean>
}

const reportArgument = process.argv.find((value) => value.startsWith('--vast-performance-report='))
const reportPath = reportArgument ? resolve(reportArgument.slice('--vast-performance-report='.length)) : undefined
const probeStartedAt = performance.now()
const marks: PerformanceMark[] = []
const counters = { storageWrites: 0, storageBytes: 0, rollingBackups: 0, storageWriteDurationMs: 0, downloadProgressEvents: 0, downloadDurableWrites: 0 }
const eventLoopDelay = reportPath ? monitorEventLoopDelay({ resolution: 20 }) : undefined
eventLoopDelay?.enable()
let ipcRegistered = false
const rendererMarkNames = new Set(['renderer-dom-ready', 'browser-shell-interactive', 'first-active-page-load-start'])

export function performanceProbeEnabled(): boolean {
  return Boolean(reportPath)
}

export function markPerformance(name: string, detail?: PerformanceMark['detail']): void {
  if (!reportPath) return
  marks.push({ name, atEpochMs: Date.now(), sinceProbeStartMs: performance.now() - probeStartedAt, detail })
}

export function recordStorageWrite(bytes: number, durationMs: number, rollingBackupCreated: boolean): void {
  if (!reportPath) return
  counters.storageWrites += 1
  counters.storageBytes += bytes
  counters.storageWriteDurationMs += durationMs
  if (rollingBackupCreated) counters.rollingBackups += 1
}

export function recordDownloadProgressEvent(): void {
  if (reportPath) counters.downloadProgressEvents += 1
}

export function recordDownloadDurableWrite(): void {
  if (reportPath) counters.downloadDurableWrites += 1
}

export function registerPerformanceProbeIpc(): void {
  if (!reportPath || ipcRegistered) return
  ipcRegistered = true
  ipcMain.on('vast:performance:mark', (event, name: unknown, detail?: unknown) => {
    if (typeof name !== 'string' || !rendererMarkNames.has(name)) return
    const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
    if (!senderUrl.startsWith('file:') && !senderUrl.startsWith('http://localhost:') && !senderUrl.startsWith('http://127.0.0.1:')) return
    markPerformance(name, detail && typeof detail === 'object' ? detail as PerformanceMark['detail'] : undefined)
  })
  ipcMain.handle('vast:performance:counters', (event) => {
    const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
    if (!senderUrl.startsWith('file:') && !senderUrl.startsWith('http://localhost:') && !senderUrl.startsWith('http://127.0.0.1:')) {
      throw new Error('Untrusted performance counter request.')
    }
    return { ...counters }
  })
}

export function flushPerformanceReport(): void {
  if (!reportPath) return
  try {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      executable: process.execPath,
      argv: process.argv.filter((value) => !value.startsWith('--vast-performance-report=')),
      marks,
      counters,
      eventLoopDelay: eventLoopDelay ? {
        meanMs: eventLoopDelay.mean / 1e6,
        maxMs: eventLoopDelay.max / 1e6,
        p95Ms: eventLoopDelay.percentile(95) / 1e6,
        p99Ms: eventLoopDelay.percentile(99) / 1e6
      } : undefined
    }, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.warn('[performance] Could not write benchmark report:', error)
  }
}

process.once('exit', flushPerformanceReport)
