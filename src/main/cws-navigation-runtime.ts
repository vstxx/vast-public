import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export interface CwsNavigationGateInput {
  isPackaged: boolean
  electronVersion: string
  chromeVersion: string
  executablePath: string
  binarySha256: string
  compatibilityEnabled: boolean
  approvedRuntime: {
    electron: { version: string; chromiumVersion: string; binary: { sha256: string } }
    cws?: { navigationApproved?: boolean }
  }
  env: NodeJS.ProcessEnv
}

export function cwsNavigationGate(input: CwsNavigationGateInput): boolean {
  const approved = input.approvedRuntime
  if (!input.compatibilityEnabled || input.env.VAST_CWS_NAVIGATION_DISABLE === '1') return false
  if (input.electronVersion !== approved.electron.version || input.chromeVersion !== approved.electron.chromiumVersion) return false
  // Packaging rewrites the executable (resources, then fuses), so its hash can
  // never equal the raw binary's. The packaged compatibility gate has already
  // matched the build-time distribution marker to the approved binary hash.
  if (input.isPackaged) return approved.cws?.navigationApproved === true
  if (input.binarySha256 !== approved.electron.binary.sha256 || !/^[a-f0-9]{64}$/.test(input.binarySha256)) return false
  const dist = input.env.VAST_PATCHED_ELECTRON_DIST?.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
  return Boolean(dist && input.executablePath.replaceAll('\\', '/').toLowerCase().startsWith(`${dist}/`))
}

export async function executableSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
