// The translation worker. Adapted from Glossa src/engine/bergamot.worker.ts (MIT, SysAdminDoc).
//
// It owns the WebAssembly instance and every loaded model, and it is the only place page text is
// processed. Bergamot translates synchronously, so the host sends one request at a time. The
// WebAssembly heap only ever grows; the host releases memory by terminating this worker.

import type { BergamotAlignedMemory, BergamotModule, BergamotTranslationModel } from './bergamot.d.ts'
import type { ModelFileType } from '../shared/catalog.ts'

interface WorkerScope {
  importScripts(...urls: string[]): void
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const scope = self as unknown as WorkerScope

// Bergamot requires these alignments for model blobs inside its heap.
const ALIGNMENT: Record<ModelFileType, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 }

// A loaded model costs about 140 MB of heap, mostly Marian's 128 MB workspace. A pivot route
// needs two at once; evict before loading another direction to avoid a third workspace.
const MAX_LOADED_MODELS = 2
const MODEL_WORKSPACE_BYTES = 128 * 1024 * 1024
const MODEL_LOAD_OVERHEAD_BYTES = 32 * 1024 * 1024
const MAX_WASM_HEAP_BYTES = 640 * 1024 * 1024

export interface WorkerModel {
  source: string
  target: string
  name: string
  files: Partial<Record<ModelFileType, ArrayBuffer>>
}

export type WorkerRequest =
  | { id: number; type: 'init'; wasm: ArrayBuffer }
  | { id: number; type: 'load'; routeKey: string; models: WorkerModel[] }
  | { id: number; type: 'translate'; routeKey: string; fragments: string[] }
  | { id: number; type: 'unload'; routeKey: string }
  | { id: number; type: 'status' }

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

interface Loaded {
  model: BergamotTranslationModel
  memory: BergamotAlignedMemory[]
  used: number
}

let engine: BergamotModule | null = null
let service: InstanceType<BergamotModule['BlockingService']> | null = null
const models = new Map<string, Loaded>()
const routes = new Map<string, string[]>()
let clock = 0

scope.importScripts('bergamot-translator.js')

scope.onmessage = (event) => {
  const message = event.data
  let response: WorkerResponse
  try {
    response = { id: message.id, ok: true, result: handle(message) }
  } catch (error) {
    response = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  // init resolves asynchronously; everything else is synchronous.
  if (response.ok && response.result instanceof Promise) {
    response.result.then(
      (result) => scope.postMessage({ id: message.id, ok: true, result }),
      (error: unknown) => scope.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    )
    return
  }
  scope.postMessage(response)
}

function handle(message: WorkerRequest): unknown {
  switch (message.type) {
    case 'init':
      return initialize(message.wasm)
    case 'load':
      loadRoute(message.routeKey, message.models)
      return { loaded: [...routes.keys()] }
    case 'translate':
      return translate(message.routeKey, message.fragments)
    case 'unload':
      unloadRoute(message.routeKey)
      return { loaded: [...routes.keys()] }
    case 'status':
      return { engine: engine !== null, routes: [...routes.keys()], models: [...models.keys()], heapBytes: engine?.HEAP8?.buffer.byteLength ?? 0 }
  }
}

function initialize(wasm: ArrayBuffer): Promise<{ heapBytes: number }> {
  if (engine) return Promise.resolve({ heapBytes: engine.HEAP8?.buffer.byteLength ?? 0 })
  return new Promise((resolve, reject) => {
    let settled = false
    const module = loadBergamot({
      // Start small and grow; Mozilla measured a lower peak this way.
      INITIAL_MEMORY: 40 * 1024 * 1024,
      wasmBinary: wasm,
      print: () => {},
      printErr: () => {},
      onAbort(reason: unknown) {
        if (settled) return
        settled = true
        reject(new Error(`Engine aborted: ${String(reason)}`))
      },
      onRuntimeInitialized() {
        queueMicrotask(() => {
          if (settled) return
          settled = true
          engine = module
          service = new module.BlockingService({ cacheSize: 0 })
          resolve({ heapBytes: module.HEAP8?.buffer.byteLength ?? 0 })
        })
      }
    })
  })
}

function requireEngine(): BergamotModule {
  if (!engine || !service) throw new Error('Engine is not initialised')
  return engine
}

const modelKey = (model: WorkerModel): string => `${model.source}-${model.target}`

function loadRoute(routeKey: string, inputs: WorkerModel[]): void {
  const module = requireEngine()
  if (inputs.length === 0 || inputs.length > 2) throw new Error('A route needs one or two models')
  const keys = inputs.map(modelKey)
  const missing = inputs.filter((input) => !models.has(modelKey(input)))
  evictFor(missing.length, new Set(keys))
  const built: string[] = []
  try {
    for (const input of missing) {
      const fileBytes = Object.values(input.files).reduce((sum, buffer) => sum + (buffer?.byteLength ?? 0), 0)
      // Emscripten's heap never shrinks, even after an eviction. Refuse a load before its model
      // bytes and Marian workspace could push the worker beyond the extension's memory budget.
      if ((module.HEAP8?.buffer.byteLength ?? 0) + fileBytes + MODEL_WORKSPACE_BYTES + MODEL_LOAD_OVERHEAD_BYTES > MAX_WASM_HEAP_BYTES) {
        throw new Error('Translation engine memory limit reached. Wait for idle release and try again.')
      }
      const memory: BergamotAlignedMemory[] = []
      try {
        models.set(modelKey(input), { model: construct(module, input, memory), memory, used: ++clock })
      } catch (error) {
        for (const block of memory) block.delete()
        throw error
      }
      built.push(modelKey(input))
    }
  } catch (error) {
    const inUse = new Set([...routes.values()].flat())
    for (const key of built) if (!inUse.has(key)) drop(key)
    throw error
  }
  const now = ++clock
  for (const key of keys) models.get(key)!.used = now
  routes.set(routeKey, keys)
}

function construct(module: BergamotModule, input: WorkerModel, memory: BergamotAlignedMemory[]): BergamotTranslationModel {
  const aligned: Partial<Record<ModelFileType, BergamotAlignedMemory>> = {}
  for (const [type, buffer] of Object.entries(input.files) as Array<[ModelFileType, ArrayBuffer]>) {
    const block = new module.AlignedMemory(buffer.byteLength, ALIGNMENT[type])
    block.getByteArrayView().set(new Uint8Array(buffer))
    aligned[type] = block
    memory.push(block)
  }
  if (!aligned.model) throw new Error(`Model ${input.name} has no model file`)
  const vocabs = new module.AlignedMemoryList()
  if (aligned.vocab) vocabs.push_back(aligned.vocab)
  else if (aligned.srcvocab && aligned.trgvocab) {
    vocabs.push_back(aligned.srcvocab)
    vocabs.push_back(aligned.trgvocab)
  } else throw new Error(`Model ${input.name} has no vocabulary`)
  const config = marianConfig({
    'beam-size': '1',
    normalize: '1.0',
    'word-penalty': '0',
    'max-length-break': '128',
    'mini-batch-words': '1024',
    workspace: '128',
    'max-length-factor': '2.0',
    'skip-cost': 'true',
    'cpu-threads': '0',
    quiet: 'true',
    'quiet-translation': 'true',
    'gemm-precision': input.name.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll',
    alignment: 'soft'
  })
  return new module.TranslationModel(input.source, input.target, config, aligned.model, aligned.lex ?? null, vocabs, null)
}

// Marian reads YAML; the indentation is part of the format.
function marianConfig(values: Record<string, string>): string {
  const indent = '            '
  let out = '\n'
  for (const [key, value] of Object.entries(values)) out += `${indent}${key}: ${value}\n`
  return out + indent
}

function evictFor(incoming: number, keep: Set<string>): void {
  while (models.size + incoming > MAX_LOADED_MODELS) {
    let oldest: string | null = null
    let stamp = Number.POSITIVE_INFINITY
    for (const [key, entry] of models) {
      if (!keep.has(key) && entry.used < stamp) {
        stamp = entry.used
        oldest = key
      }
    }
    if (oldest === null) break
    drop(oldest)
  }
}

function drop(key: string): void {
  const entry = models.get(key)
  if (!entry) return
  entry.model.delete()
  for (const block of entry.memory) block.delete()
  models.delete(key)
  for (const [routeKey, keys] of routes) if (keys.includes(key)) routes.delete(routeKey)
}

function unloadRoute(routeKey: string): void {
  const keys = routes.get(routeKey)
  if (!keys) return
  routes.delete(routeKey)
  const inUse = new Set([...routes.values()].flat())
  for (const key of keys) if (!inUse.has(key)) drop(key)
}

function translate(routeKey: string, fragments: string[]): { fragments: string[]; inferenceMs: number } {
  const module = requireEngine()
  const route = routes.get(routeKey)?.map((key) => models.get(key))
  if (!route || route.some((entry) => !entry)) throw new Error(`Route ${routeKey} is not loaded`)
  const loaded = route as Loaded[]
  const now = ++clock
  for (const entry of loaded) entry.used = now
  // Empty input crashes the decoder: keep the slot, skip the work.
  const slots: number[] = []
  const messages = new module.VectorString()
  const options = new module.VectorResponseOptions()
  const output = new Array<string>(fragments.length).fill('')
  let responses: ReturnType<NonNullable<typeof service>['translate']> | null = null
  const started = performance.now()
  try {
    fragments.forEach((fragment, index) => {
      if (!fragment.trim()) return
      slots.push(index)
      messages.push_back(fragment)
      options.push_back({ qualityScores: false, alignment: true, html: true })
    })
    if (messages.size() > 0) {
      responses = loaded.length === 1
        ? service!.translate(loaded[0]!.model, messages, options)
        : service!.translateViaPivoting(loaded[0]!.model, loaded[1]!.model, messages, options)
      for (let index = 0; index < responses.size(); index++) {
        const slot = slots[index]
        if (slot !== undefined) output[slot] = responses.get(index).getTranslatedText()
      }
    }
  } finally {
    messages.delete()
    options.delete()
    responses?.delete()
  }
  return { fragments: output, inferenceMs: performance.now() - started }
}
