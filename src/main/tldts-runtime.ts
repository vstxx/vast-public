import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

interface TldtsRuntime {
  getDomain: (input: string, options?: { allowPrivateDomains?: boolean }) => string | null
}

const TLDTS_RUNTIME_SHA256 = '7ae8df69275a9dc3d2258587a6ce375dc4de58c632151c40dfff55d71c899c3b'
const packagedRuntimePath = join(process.resourcesPath, 'runtime', 'tldts.cjs')
const runtimePath = existsSync(packagedRuntimePath)
  ? packagedRuntimePath
  : join(__dirname, '..', '..', 'node_modules', 'tldts', 'dist', 'index.cjs.min.js')

const runtimeBytes = readFileSync(runtimePath)
const runtimeHash = createHash('sha256').update(runtimeBytes).digest('hex')
if (runtimeHash !== TLDTS_RUNTIME_SHA256) {
  throw new Error('The bundled public-suffix runtime failed integrity verification.')
}

const requireRuntime = createRequire(__filename)
const runtime = requireRuntime(runtimePath) as Partial<TldtsRuntime>
if (typeof runtime.getDomain !== 'function') {
  throw new Error('The bundled public-suffix runtime is invalid.')
}

export const getDomain: TldtsRuntime['getDomain'] = runtime.getDomain
