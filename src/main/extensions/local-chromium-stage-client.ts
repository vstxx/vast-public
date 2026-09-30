import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LocalChromiumStage } from './local-chromium-stage.ts'

function stageWorkerPath(): string {
  if (!process.versions.electron) return join(process.cwd(), 'src/main/extensions/local-chromium-stage-worker.ts')
  const adjacent = join(__dirname, 'local-chromium-stage-worker.js')
  // Rollup may place this client in out/main/chunks while emitting the worker
  // as a separate out/main entry. Support both layouts without using cwd.
  return existsSync(adjacent) ? adjacent : join(__dirname, '..', 'local-chromium-stage-worker.js')
}

export async function stageLocalChromiumInWorker(
  input: { profilePath: string; sourceExtensionId: string; expectedVersion: string; fingerprint: string },
  stagingRoot: string,
  signal: AbortSignal,
  workerPath = stageWorkerPath()
): Promise<LocalChromiumStage> {
  if (signal.aborted) throw new Error('Extension staging was cancelled.')
  const operationRoot = await mkdtemp(join(stagingRoot, 'local-worker-'))
  let worker: Worker
  try {
    worker = new Worker(workerPath, { workerData: { action: 'stage-profile', ...input, stagingRoot: operationRoot },
      resourceLimits: { maxOldGenerationSizeMb: 256 } })
  } catch (error) {
    await rm(operationRoot, { recursive: true, force: true })
    throw error
  }
  return new Promise<LocalChromiumStage>((resolve, reject) => {
    let settled = false
    const finish = async (error?: Error, stage?: LocalChromiumStage): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
      try {
        await worker.terminate()
        if (error || !stage) throw error ?? new Error('Extension staging returned no copy.')
        const root = join(stagingRoot, `local-ready-${randomUUID()}`)
        await rename(stage.root, root)
        await rm(operationRoot, { recursive: true, force: true })
        resolve({ ...stage, root, contentRoot: join(root, 'content') })
      } catch (failure) {
        await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined)
        reject(failure)
      }
    }
    const onAbort = (): void => { void finish(new Error('Extension staging was cancelled.')) }
    const timer = setTimeout(() => { void finish(new Error('Extension staging timed out.')) }, 35_000)
    signal.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: { ok?: boolean; stage?: LocalChromiumStage; error?: string }) => {
      void finish(message.ok ? undefined : new Error(message.error ?? 'Extension staging failed.'), message.stage)
    })
    worker.once('error', () => { void finish(new Error('Extension staging worker failed.')) })
    worker.once('exit', (code) => { void finish(new Error(`Extension staging worker exited (${code}).`)) })
    if (signal.aborted) onAbort()
  })
}

export async function verifyLocalChromiumInWorker(contentRoot: string, fingerprint: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Local extension fingerprint is invalid.')
  const workerPath = stageWorkerPath()
  const worker = new Worker(workerPath, { workerData: { action: 'verify', contentRoot, fingerprint },
    resourceLimits: { maxOldGenerationSizeMb: 256 } })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = async (error?: Error): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.removeAllListeners()
      await worker.terminate().catch(() => undefined)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => { void finish(new Error('Local extension verification timed out.')) }, 35_000)
    worker.once('message', (message: { ok?: boolean; error?: string }) => {
      void finish(message.ok ? undefined : new Error(message.error ?? 'Local extension verification failed.'))
    })
    worker.once('error', () => { void finish(new Error('Local extension verification worker failed.')) })
    worker.once('exit', (code) => { void finish(new Error(`Local extension verification worker exited (${code}).`)) })
  })
}
