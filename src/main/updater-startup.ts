import { app } from 'electron/main'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pendingStartupDecision, pendingUpdatePath } from './updater-pending'
import { getBuildMetadata } from './build-info'
import { updaterDisabledReason } from '../shared/updater-policy'

/** Before loading profiles/webviews: hand a prepared installer to an external waiter. */
export async function applyPendingUpdateAtStartup(): Promise<boolean> {
  if (process.platform !== 'win32' || updaterDisabledReason(app.isPackaged, getBuildMetadata())) return false
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) return false
  const executable = app.getPath('exe')
  const profile = app.getPath('userData')
  const file = pendingUpdatePath(executable, profile)
  if (!existsSync(file)) return false
  try {
    const record = await pendingStartupDecision({
      executable, profile,
      cacheRoot: process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      currentVersion: app.getVersion(), skipOnce: process.argv.includes('--vast-after-update')
    })
    if (!record) return false
    const helper = join(dirname(file), 'apply-update.ps1')
    const argsFile = file + '.args.json'
    await copyFile(join(process.resourcesPath, 'apply-update.ps1'), helper)
    await writeFile(argsFile, JSON.stringify(process.argv.slice(1).filter(arg => arg !== '--vast-after-update')), 'utf8')
    const processRef = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-RecordPath', file, '-LaunchPath', executable, '-ArgumentsPath', argsFile, '-ParentProcessId', String(process.pid), '-Handshake'
    ], { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: dirname(file) })
    // A spawned PowerShell process can still be blocked by policy or fail to load
    // its script. Keep this browser alive until the waiter accepts the handoff.
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        processRef.removeListener('error', onError)
        processRef.removeListener('exit', onExit)
        processRef.stdout.removeListener('data', onData)
        if (error) { processRef.kill(); reject(error) } else resolve()
      }
      const onError = (error: Error) => finish(error)
      const onExit = () => finish(new Error('The update helper exited before accepting the handoff.'))
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-1024)
        if (output.includes('VAST_UPDATE_READY')) finish()
      }
      const timeout = setTimeout(() => finish(new Error('The update helper did not accept the handoff in time.')), 8_000)
      processRef.once('error', onError)
      processRef.once('exit', onExit)
      processRef.stdout.on('data', onData)
    })
    processRef.stdout.destroy()
    processRef.unref()
    return true
  } catch (error) {
    console.warn('[updater] Prepared update could not be handed off; keeping this version available:', error)
    return false
  }
}
