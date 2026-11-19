import { app, net, session } from 'electron/main'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import type { AvidaeModuleStatus, AvidaeStatus } from '../shared/types'
import { isPublicDistributionBuild } from '../shared/build-metadata'
import modulePolicy from '../shared/avidae-module-policy.json' with { type: 'json' }
import { vastDataPath } from './data-path'
import { portableDataRootFromEnv } from './data-path-utils'
import { getBuildMetadata } from './build-info'
import { clearAvidaeAuthorization, setAvidaeAuthorization } from './avidae-auth'
import { verifyAvidaeRuntime } from './avidae-runtime'
import { redactAvidaeLogLine } from './avidae-log'
import { AvidaeModuleManager } from './avidae-module'
import type { AvidaeModuleTrustedKey } from './avidae-module-manifest'

interface PythonCandidate {
  command: string
  args: string[]
  label: string
  sourceScript: boolean
  cwd?: string
  runtimeEnvironment?: Record<string, string>
}

let child: ChildProcess | undefined
let startPromise: Promise<AvidaeStatus> | undefined
let installPromise: Promise<AvidaeStatus> | undefined
let state: AvidaeStatus['state'] = 'stopped'
let port: number | undefined
let url: string | undefined
let error: string | undefined
let pythonLabel: string | undefined
let authToken: string | undefined
const logs: string[] = []
const execFileAsync = promisify(execFile)
let moduleManager: AvidaeModuleManager | undefined

// Test and diagnostic overrides are honoured only by development and private
// builds; public releases always use the policy compiled into Vast.
function moduleOverridesAllowed(): boolean {
  return !app.isPackaged || !isPublicDistributionBuild(getBuildMetadata())
}

// Development checkouts run the Python service from source unless a test
// points them at a module release manifest.
function usesModuleRuntime(): boolean {
  return app.isPackaged || Boolean(moduleOverridesAllowed() && process.env.VAST_AVIDAE_MODULE_MANIFEST_URL)
}

// The module lives outside the browser installation and outside the roaming
// profile: per-user local app data for Direct, the package-virtualized local
// app data for Microsoft Store, and beside "Vast Data" for Portable copies.
function moduleRoot(): string {
  const override = moduleOverridesAllowed() ? process.env.VAST_AVIDAE_MODULE_ROOT?.trim() : undefined
  if (override) return path.resolve(override)
  const portableRoot = portableDataRootFromEnv()
  if (portableRoot) return path.join(path.dirname(portableRoot), 'Vast Modules', 'video-audio')
  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(app.getPath('home'), 'AppData', 'Local')
  const metadata = getBuildMetadata()
  const product = !app.isPackaged
    ? 'Vast Dev'
    : metadata.distributionChannel === 'microsoft-store'
      ? (metadata.privateBuild ? 'Vast Store Development' : 'Vast Store')
      : 'Vast'
  return path.join(localAppData, product, 'Modules', 'video-audio')
}

function trustedModuleKeys(): AvidaeModuleTrustedKey[] {
  const keys = [...(modulePolicy.trustedKeys as AvidaeModuleTrustedKey[])]
  const testKey = moduleOverridesAllowed() ? process.env.VAST_AVIDAE_MODULE_TEST_PUBLIC_KEY?.trim() : undefined
  if (testKey) keys.push({ keyId: 'vast-avidae-test', algorithm: 'Ed25519', publicKeySpkiBase64: testKey, status: 'current' })
  return keys
}

function moduleUnavailableReason(): string | undefined {
  if (process.platform !== 'win32' || process.arch !== 'x64') return 'Video & Audio is available for Windows x64 only.'
  if (app.isPackaged && getBuildMetadata().distributionChannel === 'microsoft-store' && modulePolicy.microsoftStoreDownloads !== true) {
    return 'Video & Audio is not available in the Microsoft Store edition of Vast.'
  }
  return undefined
}

function avidaeModule(): AvidaeModuleManager {
  if (moduleManager) return moduleManager
  const overrideUrl = moduleOverridesAllowed() ? process.env.VAST_AVIDAE_MODULE_MANIFEST_URL?.trim() : undefined
  // A dedicated in-memory session keeps module downloads out of browsing
  // history, extensions and content blocking while honouring system proxies.
  const downloadSession = session.fromPartition('vast-avidae-module')
  moduleManager = new AvidaeModuleManager({
    root: moduleRoot(),
    manifestUrl: overrideUrl || modulePolicy.manifestUrl || undefined,
    trustedKeys: trustedModuleKeys(),
    unavailableReason: moduleUnavailableReason(),
    revokedModuleVersions: modulePolicy.revokedModuleVersions,
    vastVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    allowLoopbackHttp: moduleOverridesAllowed(),
    fetch: (input, init) => downloadSession.fetch(input, init),
    isOnline: () => net.isOnline()
  })
  return moduleManager
}

function moduleStatus(): AvidaeModuleStatus {
  if (!usesModuleRuntime()) return { state: 'ready', development: true, canCancel: false }
  return avidaeModule().status()
}

export function onAvidaeModuleChanged(listener: (status: AvidaeModuleStatus) => void): () => void {
  if (!usesModuleRuntime()) return () => undefined
  return avidaeModule().onChange(listener)
}

// Re-reads the installation and, once per session, the signed release
// metadata. Only the Video & Audio page triggers this.
export function refreshAvidaeModule(): void {
  if (usesModuleRuntime()) void avidaeModule().refresh({ checkRelease: true })
}

export async function installAvidaeModule(): Promise<AvidaeStatus> {
  if (!usesModuleRuntime()) return status()
  if (child || startPromise) await stopAvidae()
  appendLog('Downloading and installing the Video & Audio runtime.')
  const result = await avidaeModule().install()
  if (result.state === 'ready' && !result.error) appendLog(`Video & Audio runtime ${result.installedVersion} is installed.`)
  else if (result.error) appendLog(result.error)
  return status()
}

export function cancelAvidaeModuleInstall(): AvidaeStatus {
  if (usesModuleRuntime()) avidaeModule().cancel()
  return status()
}

const inheritedEnvironmentKeys = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PLAYWRIGHT_BROWSERS_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH'
] as const

function paths(): Pick<AvidaeStatus, 'sourcePath' | 'dataPath'> {
  const sourcePath = usesModuleRuntime()
    ? moduleRoot()
    : path.join(process.cwd(), 'resources', 'avidae')
  return {
    sourcePath,
    dataPath: path.join(vastDataPath(), 'avidae')
  }
}

function appendLog(line: string): void {
  const normalized = redactAvidaeLogLine(line, authToken).replace(/\r/g, '').trim()
  if (!normalized) return
  for (const item of normalized.split('\n')) {
    const trimmed = item.trim()
    if (trimmed) logs.push(trimmed.slice(0, 1200))
  }
  while (logs.length > 160) logs.shift()
}

function isolatedEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return { ...env, ...extra }
}

function status(): AvidaeStatus {
  return {
    state,
    url,
    port,
    error,
    python: pythonLabel,
    logs: [...logs],
    module: moduleStatus(),
    ...paths()
  }
}

async function pythonCandidates(): Promise<PythonCandidate[]> {
  if (usesModuleRuntime()) {
    const active = await avidaeModule().activeRuntime()
    let runtime
    try {
      runtime = await verifyAvidaeRuntime(active.root, active)
    } catch (verificationError) {
      const message = verificationError instanceof Error ? verificationError.message : String(verificationError)
      avidaeModule().markRepairRequired(`${message} Reinstall the Video & Audio runtime.`)
      throw verificationError
    }
    return [{
      command: runtime.executable,
      args: [],
      label: runtime.label,
      sourceScript: false,
      cwd: path.dirname(runtime.executable),
      runtimeEnvironment: {
        FFMPEG_PATH: runtime.ffmpeg,
        FFPROBE_PATH: runtime.ffprobe,
        PLAYWRIGHT_BROWSERS_PATH: runtime.playwrightBrowsersPath,
        VAST_AVIDAE_CHROMIUM_PATH: runtime.chromiumExecutable,
        VAST_AVIDAE_BUNDLED_RUNTIME: '1'
      }
    }]
  }
  if (!app.isPackaged && process.env.VAST_AVIDAE_PYTHON) {
    return [{ command: process.env.VAST_AVIDAE_PYTHON, args: [], label: process.env.VAST_AVIDAE_PYTHON, sourceScript: true }]
  }
  if (process.platform === 'win32') {
    return [
      { command: 'python', args: [], label: 'python', sourceScript: true },
      { command: 'py', args: ['-3'], label: 'py -3', sourceScript: true }
    ]
  }
  return [
    { command: 'python3', args: [], label: 'python3', sourceScript: true },
    { command: 'python', args: [], label: 'python', sourceScript: true }
  ]
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port)
        else reject(new Error('Could not allocate a local port for Video & Audio.'))
      })
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForExit(processRef: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (processRef.exitCode !== null) {
      resolve()
      return
    }
    processRef.once('exit', () => resolve())
  })
}

async function stopChildProcess(processRef: ChildProcess): Promise<void> {
  if (processRef.exitCode !== null) return
  processRef.kill('SIGTERM')
  await Promise.race([waitForExit(processRef), wait(3_000)])
  if (processRef.exitCode !== null || !processRef.pid) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(processRef.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch(() => undefined)
  } else {
    try {
      process.kill(-processRef.pid, 'SIGKILL')
    } catch {
      processRef.kill('SIGKILL')
    }
  }
  await Promise.race([waitForExit(processRef), wait(2_000)])
}

async function waitForHealthy(targetUrl: string, processRef: ChildProcess, getProcessError: () => Error | undefined): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 25000) {
    const processError = getProcessError()
    if (processError) {
      throw processError
    }
    if (processRef.exitCode !== null) {
      throw new Error(`Video & Audio exited early with code ${processRef.exitCode}.`)
    }
    try {
      const response = await fetch(`${targetUrl}/api/stats`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(1_500)
      })
      if (response.ok) return
    } catch {
      // Flask is still binding the local port.
    }
    await wait(350)
  }
  throw new Error('Video & Audio did not become ready within 25 seconds.')
}

function spawnAvidae(candidate: PythonCandidate, allocatedPort: number, launchToken: string): ChildProcess {
  const currentPaths = paths()
  const appPath = path.join(currentPaths.sourcePath, 'app.py')
  const processArgs = candidate.sourceScript ? [...candidate.args, appPath] : [...candidate.args]
  return spawn(candidate.command, processArgs, {
    cwd: candidate.cwd ?? currentPaths.sourcePath,
    env: isolatedEnvironment({
      PORT: String(allocatedPort),
      AVIDAE_HOST: '127.0.0.1',
      AVIDAE_DEBUG: '0',
      AVIDAE_EMBEDDED: '1',
      AVIDAE_DATA_DIR: currentPaths.dataPath,
      AVIDAE_AUTH_TOKEN: launchToken,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ...(candidate.runtimeEnvironment ?? {})
    }),
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function tryStart(candidate: PythonCandidate): Promise<AvidaeStatus> {
  const currentPaths = paths()
  if (candidate.sourceScript && !existsSync(path.join(currentPaths.sourcePath, 'app.py'))) {
    throw new Error(`Video & Audio source was not found at ${currentPaths.sourcePath}.`)
  }
  await mkdir(currentPaths.dataPath, { recursive: true })
  pythonLabel = candidate.label
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const allocatedPort = await freePort()
    const targetUrl = `http://127.0.0.1:${allocatedPort}`
    port = allocatedPort
    url = targetUrl
    appendLog(`Starting Video & Audio with ${candidate.label} on ${targetUrl} (attempt ${attempt}/3)`)

    const launchToken = randomBytes(32).toString('base64url')
    authToken = launchToken
    setAvidaeAuthorization(targetUrl, launchToken)
    const processRef = spawnAvidae(candidate, allocatedPort, launchToken)
    let processError: Error | undefined
    child = processRef
    processRef.stdout?.on('data', (chunk) => appendLog(String(chunk)))
    processRef.stderr?.on('data', (chunk) => appendLog(String(chunk)))
    processRef.once('error', (spawnError) => {
      processError = spawnError
      appendLog(`Process error: ${spawnError.message}`)
    })
    processRef.once('exit', (code, signal) => {
      appendLog(`Video & Audio process exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`)
      if (child === processRef) {
        child = undefined
        clearAvidaeAuthorization()
        if (state !== 'stopped') {
          state = code === 0 || signal ? 'stopped' : 'error'
          error = code === 0 || signal ? undefined : `Video & Audio exited with code ${code ?? 'unknown'}.`
        }
      }
    })

    try {
      await waitForHealthy(targetUrl, processRef, () => processError)
      state = 'running'
      error = undefined
      return status()
    } catch (startupError) {
      lastError = startupError instanceof Error ? startupError : new Error(String(startupError))
      appendLog(`${candidate.label} startup attempt ${attempt} failed: ${lastError.message}`)
      await stopChildProcess(processRef)
      if (attempt < 3) {
        appendLog('Retrying Video & Audio startup with a new local port.')
      }
    }
  }

  throw lastError ?? new Error('Could not start Video & Audio.')
}

export function getAvidaeStatus(): AvidaeStatus {
  return status()
}

export async function startAvidae(): Promise<AvidaeStatus> {
  if (state === 'running' && child && url) return status()
  if (startPromise) return startPromise

  if (child) {
    await stopChildProcess(child)
    child = undefined
    clearAvidaeAuthorization()
  }

  if (usesModuleRuntime()) {
    // A missing, damaged or in-progress module is an installation state, not
    // a backend failure. The page offers installation instead of Start.
    const module = await avidaeModule().refresh()
    if (module.state !== 'ready') {
      appendLog('The Video & Audio runtime is not installed or needs attention.')
      return status()
    }
  }

  startPromise = (async () => {
    state = 'starting'
    error = undefined
    let candidates: PythonCandidate[] = []
    try {
      candidates = await pythonCandidates()
    } catch (runtimeError) {
      error = runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
      appendLog(error)
    }
    for (const candidate of candidates) {
      try {
        return await tryStart(candidate)
      } catch (candidateError) {
        const message = candidateError instanceof Error ? candidateError.message : String(candidateError)
        appendLog(`${candidate.label} failed: ${message}`)
        if (child) {
          await stopChildProcess(child)
          child = undefined
        }
        error = message
      }
    }
    state = 'error'
    throw new Error(error || 'Could not start Video & Audio.')
  })()

  try {
    return await startPromise
  } catch {
    return status()
  } finally {
    startPromise = undefined
  }
}

export async function stopAvidae(): Promise<AvidaeStatus> {
  if (child) {
    appendLog('Stopping Video & Audio.')
    await stopChildProcess(child)
    child = undefined
  }
  state = 'stopped'
  error = undefined
  port = undefined
  url = undefined
  authToken = undefined
  clearAvidaeAuthorization()
  const dataRoot = path.resolve(paths().dataPath)
  const tempRoot = path.resolve(dataRoot, 'temp')
  if (tempRoot.startsWith(`${dataRoot}${path.sep}`)) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  return status()
}

async function runTool(candidate: PythonCandidate, args: string[]): Promise<void> {
  const currentPaths = paths()
  await new Promise<void>((resolve, reject) => {
    const processRef = spawn(candidate.command, [...candidate.args, ...args], {
      cwd: currentPaths.sourcePath,
      env: isolatedEnvironment({
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    processRef.stdout?.on('data', (chunk) => appendLog(String(chunk)))
    processRef.stderr?.on('data', (chunk) => appendLog(String(chunk)))
    processRef.once('error', reject)
    processRef.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${candidate.label} ${args.join(' ')} exited with code ${code}.`))
    })
  })
}

export async function installAvidaeDependencies(): Promise<AvidaeStatus> {
  if (installPromise) return installPromise
  installPromise = (async () => {
    // Development-only: installs Python packages into the developer's own
    // interpreter. Packaged builds install the verified module instead.
    if (usesModuleRuntime()) {
      appendLog('Python dependency installation is only available in development checkouts.')
      return status()
    }
    await stopAvidae()
    state = 'installing'
    error = undefined
    const currentPaths = paths()
    const requirementsPath = path.join(currentPaths.sourcePath, 'requirements.txt')
    for (const candidate of await pythonCandidates()) {
      pythonLabel = candidate.label
      appendLog(`Installing Video & Audio dependencies with ${candidate.label}`)
      try {
        await runTool(candidate, ['-m', 'pip', 'install', '-r', requirementsPath])
        await runTool(candidate, ['-m', 'playwright', 'install', 'chromium'])
        appendLog('Video & Audio dependencies installed.')
        state = 'stopped'
        return await startAvidae()
      } catch (installError) {
        error = installError instanceof Error ? installError.message : String(installError)
        appendLog(`${candidate.label} dependency install failed: ${error}`)
      }
    }
    state = 'error'
    return status()
  })()

  try {
    return await installPromise
  } finally {
    installPromise = undefined
  }
}
