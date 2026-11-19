// Runs in the offscreen document. Owns the translation worker, the model store and the request
// queue, and releases everything after a period without work.
//
// Lifecycle: uninitialized -> loading -> ready <-> translating -> idle -> released, with error from
// any state. Released terminates the worker (the only way to give a WebAssembly heap back) and lets
// the offscreen document close; the next request starts again from loading.

import { pairDiskBytes, pairDownloadBytes, pairKey, parseCatalog, planRoute, type Catalog, type CatalogPair } from '../shared/catalog.ts'
import { SCOPE, type DownloadProgress, type EnginePhase, type RouteStatus } from '../shared/protocol.ts'
import { prepareForEngine, restoreEdges } from '../shared/text.ts'
import { ModelError, ModelStore } from './model-store.ts'
import type { WorkerModel, WorkerRequest, WorkerResponse } from './worker.ts'

export const DEFAULT_IDLE_MS = 30_000
const MAX_QUEUED_JOBS = 512
const MAX_RESTARTS = 1

// A minimal module using one SIMD instruction; the engine build requires WebAssembly SIMD.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])

export class EngineError extends Error {
  constructor(message: string, readonly code: 'model-missing' | 'unsupported' | 'cancelled' | 'released' | 'engine' | 'no-route') {
    super(message)
    this.name = 'EngineError'
  }
}

interface Job {
  source: string
  target: string
  fragments: string[]
  priority: 'page' | 'selection'
  tag: string
  resolve: (value: { fragments: string[]; inferenceMs: number }) => void
  reject: (error: Error) => void
}

type PendingCall = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class EngineHost {
  readonly store: ModelStore
  phase: EnginePhase = 'uninitialized'
  onPhase: ((phase: EnginePhase) => void) | null = null
  onRelease: (() => void) | null = null
  private catalogPromise: Promise<Catalog> | null = null
  private worker: Worker | null = null
  private workerReady: Promise<void> | null = null
  private readonly calls = new Map<number, PendingCall>()
  private nextCall = 1
  private readonly loadedRoutes = new Set<string>()
  private readonly routeLoads = new Map<string, Promise<string>>()
  private readonly jobs: Job[] = []
  private running = false
  private idleMs = DEFAULT_IDLE_MS
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private active = 0
  readonly metrics = { coldStarts: 0, routeLoads: 0, translations: 0, released: 0, lastInitMs: 0, lastRouteLoadMs: 0 }

  constructor(onProgress: (progress: DownloadProgress) => void) {
    this.store = new ModelStore((progress) => {
      onProgress(progress)
      if (progress.phase !== 'download' && progress.phase !== 'store') this.touch()
    })
  }

  configure(idleMs: number): void {
    this.idleMs = Math.min(600_000, Math.max(5_000, idleMs))
    this.touch()
  }

  catalog(): Promise<Catalog> {
    this.catalogPromise ??= fetch(chrome.runtime.getURL('catalog/models.json')).then((response) => response.json()).then(parseCatalog)
    this.catalogPromise.catch(() => { this.catalogPromise = null })
    return this.catalogPromise
  }

  private setPhase(phase: EnginePhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.onPhase?.(phase)
  }

  // Wraps every request so the idle timer only starts once nothing is in flight.
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.active += 1
    this.clearIdle()
    try {
      return await work()
    } finally {
      this.active -= 1
      this.touch()
    }
  }

  async routeStatus(source: string, target: string): Promise<RouteStatus> {
    const catalog = await this.catalog()
    const route = planRoute(catalog, source, target)
    if (!route) return { source, target, available: false, pivot: false, hops: [], downloadBytes: 0, installed: false }
    const hops = []
    for (const pair of route) {
      hops.push({ pairKey: pairKey(pair.source, pair.target), installed: await this.store.isInstalled(pair), downloadBytes: pairDownloadBytes(pair), diskBytes: pairDiskBytes(pair) })
    }
    return {
      source,
      target,
      available: true,
      pivot: route.length > 1,
      hops,
      downloadBytes: hops.filter((hop) => !hop.installed).reduce((sum, hop) => sum + hop.downloadBytes, 0),
      installed: hops.every((hop) => hop.installed)
    }
  }

  // Downloads whatever the route lacks. Only ever called for an explicit user action.
  async download(source: string, target: string): Promise<RouteStatus> {
    const catalog = await this.catalog()
    const route = planRoute(catalog, source, target)
    if (!route) throw new EngineError(`No model is available for ${source} to ${target}`, 'no-route')
    for (const pair of route) {
      if (!await this.store.isInstalled(pair)) await this.store.download(pair)
    }
    return this.routeStatus(source, target)
  }

  translate(source: string, target: string, fragments: string[], priority: 'page' | 'selection', tag: string): Promise<{ fragments: string[]; inferenceMs: number }> {
    if (this.jobs.length >= MAX_QUEUED_JOBS) return Promise.reject(new EngineError('Too many translations are waiting', 'engine'))
    return new Promise((resolve, reject) => {
      const job: Job = { source, target, fragments, priority, tag, resolve, reject }
      // A selection is a person waiting for one answer; it goes ahead of queued page batches.
      if (priority === 'selection') {
        const firstPage = this.jobs.findIndex((entry) => entry.priority === 'page')
        this.jobs.splice(firstPage < 0 ? this.jobs.length : firstPage, 0, job)
      } else this.jobs.push(job)
      this.clearIdle()
      void this.drain()
    })
  }

  cancel(tag: string): number {
    let removed = 0
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index]!
      if (job.tag !== tag) continue
      this.jobs.splice(index, 1)
      job.reject(new EngineError('Translation cancelled', 'cancelled'))
      removed += 1
    }
    return removed
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    this.active += 1
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        try {
          job.resolve(await this.translateNow(job))
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } finally {
      this.running = false
      this.active -= 1
      if (this.phase === 'translating') this.setPhase('ready')
      this.touch()
    }
  }

  private async translateNow(job: Job): Promise<{ fragments: string[]; inferenceMs: number }> {
    const prepared = job.fragments.map((fragment) => prepareForEngine(fragment, job.source))
    const slots = prepared.flatMap((entry, index) => entry.core ? [index] : [])
    const fragments = new Array<string>(prepared.length).fill('')
    if (slots.length === 0) return { fragments, inferenceMs: 0 }
    let restarts = 0
    let reloaded = false
    for (;;) {
      const workerBefore = this.worker
      try {
        const routeKey = await this.ensureRoute(job.source, job.target)
        this.setPhase('translating')
        try {
          const result = await this.call({ id: 0, type: 'translate', routeKey, fragments: slots.map((slot) => prepared[slot]!.core) }) as { fragments: string[]; inferenceMs: number }
          this.metrics.translations += 1
          slots.forEach((slot, position) => { fragments[slot] = restoreEdges(result.fragments[position] ?? '', prepared[slot]!) })
          return { fragments, inferenceMs: result.inferenceMs }
        } catch (error) {
          // The worker evicted the route for another one between load and use: load it again once.
          if (reloaded || !/is not loaded/.test(error instanceof Error ? error.message : '')) throw error
          reloaded = true
          this.loadedRoutes.delete(routeKey)
        }
      } catch (error) {
        const workerDied = workerBefore !== null && this.worker === null
        if (!workerDied || restarts >= MAX_RESTARTS) throw error
        restarts += 1
      }
    }
  }

  private async ensureRoute(source: string, target: string): Promise<string> {
    const catalog = await this.catalog()
    const route = planRoute(catalog, source, target)
    if (!route) throw new EngineError(`No model is available for ${source} to ${target}`, 'no-route')
    const routeKey = route.map((pair) => pairKey(pair.source, pair.target)).join('|')
    if (this.loadedRoutes.has(routeKey)) return routeKey
    const inFlight = this.routeLoads.get(routeKey)
    if (inFlight) return inFlight
    const load = this.loadRoute(routeKey, route).finally(() => this.routeLoads.delete(routeKey))
    this.routeLoads.set(routeKey, load)
    return load
  }

  private async loadRoute(routeKey: string, route: CatalogPair[]): Promise<string> {
    for (const pair of route) {
      if (!await this.store.isInstalled(pair)) throw new EngineError(`The ${pair.source} to ${pair.target} language model is not downloaded`, 'model-missing')
    }
    await this.ensureWorker()
    this.setPhase('loading')
    const started = performance.now()
    const models: WorkerModel[] = []
    const transfer: ArrayBuffer[] = []
    for (const pair of route) {
      let files
      try {
        files = await this.store.read(pair)
      } catch (error) {
        if (error instanceof ModelError) throw new EngineError(error.message, 'model-missing')
        throw error
      }
      // The buffers come fresh from the cache; transferring them avoids a second copy.
      for (const buffer of Object.values(files)) if (buffer) transfer.push(buffer)
      models.push({ source: pair.source, target: pair.target, name: pair.files.model!.name, files })
    }
    try {
      await this.call({ id: 0, type: 'load', routeKey, models }, transfer)
    } finally {
      await this.syncRoutes()
    }
    this.metrics.routeLoads += 1
    this.metrics.lastRouteLoadMs = performance.now() - started
    this.setPhase('ready')
    return routeKey
  }

  private async syncRoutes(): Promise<void> {
    this.loadedRoutes.clear()
    try {
      const status = await this.call({ id: 0, type: 'status' }) as { routes: string[] }
      for (const key of status.routes) this.loadedRoutes.add(key)
    } catch {
      // A worker that died here has no routes; the set stays empty.
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady
    let supported = false
    try {
      supported = WebAssembly.validate(SIMD_PROBE)
    } catch {
      supported = false
    }
    if (!supported) return Promise.reject(new EngineError('This processor lacks the WebAssembly SIMD support the translation engine needs.', 'unsupported'))
    this.setPhase('loading')
    const started = performance.now()
    this.workerReady = (async () => {
      const worker = new Worker(chrome.runtime.getURL('engine-worker.js'))
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onWorkerMessage(event.data)
      worker.onerror = (event) => {
        event.preventDefault()
        this.workerFailed(new EngineError(`The translation engine stopped: ${event.message || 'worker error'}`, 'engine'))
      }
      this.worker = worker
      const response = await fetch(chrome.runtime.getURL('bergamot-translator.wasm'))
      if (!response.ok) throw new EngineError('The packaged engine binary is missing', 'engine')
      const wasm = await response.arrayBuffer()
      await this.call({ id: 0, type: 'init', wasm }, [wasm])
      this.metrics.coldStarts += 1
      this.metrics.lastInitMs = performance.now() - started
    })().catch((error: unknown) => {
      this.terminateWorker()
      this.setPhase('error')
      throw error
    })
    return this.workerReady
  }

  private workerFailed(error: Error): void {
    for (const pending of this.calls.values()) pending.reject(error)
    this.calls.clear()
    this.terminateWorker()
    this.setPhase('error')
  }

  private terminateWorker(): void {
    this.worker?.terminate()
    this.worker = null
    this.workerReady = null
    this.loadedRoutes.clear()
    this.routeLoads.clear()
  }

  private onWorkerMessage(message: WorkerResponse): void {
    const pending = this.calls.get(message.id)
    if (!pending) return
    this.calls.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new EngineError(message.error, 'engine'))
  }

  private call(request: WorkerRequest, transfer: ArrayBuffer[] = []): Promise<unknown> {
    const worker = this.worker
    if (!worker) return Promise.reject(new EngineError('The translation engine is not running', 'released'))
    const id = this.nextCall++
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject })
      worker.postMessage({ ...request, id }, transfer)
    })
  }

  async status(): Promise<{ phase: EnginePhase; heapBytes: number; routes: string[]; downloads: DownloadProgress[]; queued: number; metrics: EngineHost['metrics'] }> {
    let heapBytes = 0
    let routes: string[] = []
    if (this.worker && this.workerReady) {
      try {
        await this.workerReady
        const status = await this.call({ id: 0, type: 'status' }) as { heapBytes: number; routes: string[] }
        heapBytes = status.heapBytes
        routes = status.routes
      } catch {
        // Reported as released below.
      }
    }
    return { phase: this.phase, heapBytes, routes, downloads: this.store.downloadState(), queued: this.jobs.length, metrics: { ...this.metrics } }
  }

  async unloadPair(key: string): Promise<void> {
    for (const routeKey of [...this.loadedRoutes]) {
      if (!routeKey.split('|').includes(key)) continue
      await this.call({ id: 0, type: 'unload', routeKey }).catch(() => undefined)
      this.loadedRoutes.delete(routeKey)
    }
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  // Restarts the idle countdown. Nothing is released while a request, a queued job or a download
  // is in progress; the countdown starts again when they finish.
  touch(): void {
    this.clearIdle()
    if (this.active > 0 || this.jobs.length > 0) return
    if (this.phase === 'ready') this.setPhase('idle')
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.active > 0 || this.jobs.length > 0 || this.store.activeDownloads > 0) {
        this.touch()
        return
      }
      this.release()
    }, this.idleMs)
  }

  // closeDocument is false when a request releases the engine and still has to answer.
  release(closeDocument = true): void {
    this.clearIdle()
    const released = new EngineError('The translation engine was released', 'released')
    for (const job of this.jobs.splice(0)) job.reject(released)
    for (const pending of this.calls.values()) pending.reject(released)
    this.calls.clear()
    this.terminateWorker()
    this.metrics.released += 1
    this.setPhase('released')
    if (closeDocument) this.onRelease?.()
  }
}
