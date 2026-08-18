import { app } from 'electron/main'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import type { AvidaeStatus } from '../shared/types'
import { vastDataPath } from './data-path'
import { clearAvidaeAuthorization, setAvidaeAuthorization } from './avidae-auth'
import { verifyBundledAvidaeRuntime } from './avidae-runtime'

interface PythonCandidate {
  command: string
  args: string[]
  label: string
  sourceScript: boolean
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
let runtimeBundled = false
let authToken: string | undefined
const logs: string[] = []
const execFileAsync = promisify(execFile)

const inheritedEnvironmentKeys = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PLAYWRIGHT_BROWSERS_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH'
] as const

function paths(): Pick<AvidaeStatus, 'sourcePath' | 'dataPath'> {
  const sourcePath = app.isPackaged
    ? path.join(process.resourcesPath, 'avidae')
    : path.join(process.cwd(), 'resources', 'avidae')
  return {
    sourcePath,
    dataPath: path.join(vastDataPath(), 'avidae')
  }
}

function appendLog(line: string): void {
  const normalized = (authToken ? line.split(authToken).join('[redacted]') : line).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').replace(/\r/g, '').trim()
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
    runtimeBundled,
    logs: [...logs],
    ...paths()
  }
}

async function pythonCandidates(): Promise<PythonCandidate[]> {
  if (app.isPackaged) {
    const runtime = await verifyBundledAvidaeRuntime(process.resourcesPath)
    return [{
      command: runtime.executable,
      args: [],
      label: runtime.label,
      sourceScript: false,
      runtimeEnvironment: {
        FFMPEG_PATH: runtime.ffmpeg,
        FFPROBE_PATH: runtime.ffprobe,
        PLAYWRIGHT_BROWSERS_PATH: runtime.playwrightBrowsersPath
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
    cwd: currentPaths.sourcePath,
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
  runtimeBundled = !candidate.sourceScript
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
  runtimeBundled = false
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
    if (app.isPackaged && process.env.VAST_ALLOW_RUNTIME_INSTALL !== '1') {
      state = 'error'
      error =
        'Runtime dependency install is disabled in release builds. Bundle Video & Audio dependencies during packaging or use a trusted diagnostic build.'
      appendLog(error)
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
