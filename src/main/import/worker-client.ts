import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { BrowserImportDataType, BrowserSourceSnapshot } from '../../shared/browser-import.ts'
import type { ResolvedImportSource } from './profile-discovery.ts'
import { ensureImportStagingRoot } from './sqlite-snapshot.ts'

const DEFAULT_TIMEOUT_MS = 30_000

export interface ImportWorkerOptions {
  /** Test-only override. Production always uses the bundled worker beside main.js. */
  workerPath?: string
  stagingRoot?: string
  timeoutMs?: number
}

export function resolveBundledImportWorkerPath(directory: string, exists: (candidate: string) => boolean = existsSync): string {
  const adjacent = join(directory, 'browser-import-worker.js')
  if (exists(adjacent)) return adjacent
  // Rollup can move this client into out/main/chunks while the worker remains
  // a separate out/main entry. Resolve only those two expected layouts.
  const parent = join(directory, '..', 'browser-import-worker.js')
  if (exists(parent)) return parent
  throw new Error('Bundled browser import worker is missing')
}

export async function readBrowserSource(
  source: ResolvedImportSource,
  types: readonly BrowserImportDataType[],
  signal: AbortSignal,
  options: ImportWorkerOptions = {}
): Promise<BrowserSourceSnapshot> {
  if (signal.aborted) throw new Error('Browser import cancelled')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('Invalid browser import timeout')
  }
  const stagingRoot = options.stagingRoot ?? (process.versions.electron
    ? join((await import('electron/main')).app.getPath('userData'), 'ImportStaging')
    : join(tmpdir(), 'VastBrowserImportStaging'))
  await ensureImportStagingRoot(stagingRoot)
  const workerStagingRoot = await mkdtemp(join(stagingRoot, 'worker-'))
  const workerPath = options.workerPath ?? (process.versions.electron
    ? resolveBundledImportWorkerPath(__dirname)
    : join(process.cwd(), 'src/main/import/source-worker.ts'))
  let worker: Worker
  try {
    worker = new Worker(workerPath, {
      workerData: { source, types: [...types], stagingRoot: workerStagingRoot },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    })
  } catch (error) {
    await rm(workerStagingRoot, { recursive: true, force: true })
    throw error
  }
  return await new Promise<BrowserSourceSnapshot>((resolve, reject) => {
    let settled = false
    const finish = async (error?: Error, result?: BrowserSourceSnapshot): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
      try {
        await worker.terminate()
        await rm(workerStagingRoot, { recursive: true, force: true })
      } catch {
        reject(new Error('Browser import worker cleanup failed'))
        return
      }
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('Browser import worker returned no result'))
    }
    const onAbort = (): void => { void finish(new Error('Browser import cancelled')) }
    const timer = setTimeout(() => { void finish(new Error('Browser import worker timed out')) }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: { ok?: boolean; snapshot?: BrowserSourceSnapshot }) => {
      if (!message?.ok || !message.snapshot) {
        void finish(new Error('Browser import worker failed'))
        return
      }
      void finish(undefined, message.snapshot)
    })
    worker.once('error', () => { void finish(new Error('Browser import worker failed')) })
    worker.once('exit', (code) => {
      void finish(new Error(`Browser import worker exited without a result (${code})`))
    })
    if (signal.aborted) onAbort()
  })
}
