import { shell } from 'electron/common'
import { app } from 'electron/main'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getBuildMetadata } from './build-info'

const execFileAsync = promisify(execFile)
const WINDOWS_REGISTERED_APP_NAME = 'Vast'
const WINDOWS_CLIENT_KEY = 'HKCU\\Software\\Clients\\StartMenuInternet\\Vast'
const WINDOWS_CAPABILITIES_PATH = 'Software\\Clients\\StartMenuInternet\\Vast\\Capabilities'
const VAST_PROG_ID = 'VastHTML'
const VAST_PDF_PROG_ID = 'VastPDF'

export interface DefaultBrowserStatus {
  supported: boolean
  isDefault: boolean
  platform: string
  settingsUri?: string
  message: string
}

function appExePath(): string {
  return app.isPackaged ? app.getPath('exe') : process.execPath
}

function openCommand(): string {
  const exe = appExePath()
  const devArg = !app.isPackaged && process.argv[1] ? ` "${process.argv[1]}"` : ''
  return `"${exe}"${devArg} "%1"`
}

async function regAdd(key: string, args: string[]): Promise<void> {
  await execFileAsync('reg.exe', ['add', key, ...args, '/f'], {
    windowsHide: true,
    timeout: 10_000
  })
}

async function registerWindowsDefaultBrowserCapabilities(): Promise<void> {
  // Packaged apps declare their protocols in AppxManifest.xml. Writing a
  // second unpackaged registration would leave stale handlers after MSIX
  // uninstall and can point Windows at a versioned WindowsApps path.
  if (getBuildMetadata().distributionChannel === 'microsoft-store') return
  const exe = appExePath()
  await regAdd('HKCU\\Software\\RegisteredApplications', ['/v', WINDOWS_REGISTERED_APP_NAME, '/t', 'REG_SZ', '/d', WINDOWS_CAPABILITIES_PATH])
  await regAdd(WINDOWS_CLIENT_KEY, ['/ve', '/t', 'REG_SZ', '/d', 'Vast'])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\DefaultIcon`, ['/ve', '/t', 'REG_SZ', '/d', `${exe},0`])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\shell\\open\\command`, ['/ve', '/t', 'REG_SZ', '/d', `"${exe}"`])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\Capabilities`, ['/v', 'ApplicationName', '/t', 'REG_SZ', '/d', 'Vast'])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\Capabilities`, ['/v', 'ApplicationDescription', '/t', 'REG_SZ', '/d', 'Vast Browser'])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\Capabilities`, ['/v', 'ApplicationIcon', '/t', 'REG_SZ', '/d', `${exe},0`])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\Capabilities\\URLAssociations`, ['/v', 'http', '/t', 'REG_SZ', '/d', VAST_PROG_ID])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\Capabilities\\URLAssociations`, ['/v', 'https', '/t', 'REG_SZ', '/d', VAST_PROG_ID])
  await regAdd(`${WINDOWS_CLIENT_KEY}\\Capabilities\\FileAssociations`, ['/v', '.pdf', '/t', 'REG_SZ', '/d', VAST_PDF_PROG_ID])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PROG_ID}`, ['/ve', '/t', 'REG_SZ', '/d', 'Vast HTML Document'])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PROG_ID}\\Application`, ['/v', 'ApplicationName', '/t', 'REG_SZ', '/d', 'Vast'])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PROG_ID}\\Application`, ['/v', 'ApplicationCompany', '/t', 'REG_SZ', '/d', 'Vast'])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PROG_ID}\\DefaultIcon`, ['/ve', '/t', 'REG_SZ', '/d', `${exe},0`])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PROG_ID}\\shell\\open\\command`, ['/ve', '/t', 'REG_SZ', '/d', openCommand()])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PDF_PROG_ID}`, ['/ve', '/t', 'REG_SZ', '/d', 'PDF Document'])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PDF_PROG_ID}\\Application`, ['/v', 'ApplicationName', '/t', 'REG_SZ', '/d', 'Vast'])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PDF_PROG_ID}\\Application`, ['/v', 'ApplicationCompany', '/t', 'REG_SZ', '/d', 'Vast'])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PDF_PROG_ID}\\DefaultIcon`, ['/ve', '/t', 'REG_SZ', '/d', `${exe},0`])
  await regAdd(`HKCU\\Software\\Classes\\${VAST_PDF_PROG_ID}\\shell\\open\\command`, ['/ve', '/t', 'REG_SZ', '/d', openCommand()])
}

export function getDefaultBrowserStatus(): DefaultBrowserStatus {
  const supported = process.platform === 'win32'
  if (!supported) {
    return {
      supported: false,
      isDefault: false,
      platform: process.platform,
      message: 'Default browser setup is currently implemented for Windows.'
    }
  }
  const isDefault = app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https')
  return {
    supported: true,
    isDefault,
    platform: process.platform,
    settingsUri: `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(WINDOWS_REGISTERED_APP_NAME)}`,
    message: isDefault ? 'Vast is the default handler for http and https.' : 'Vast can be selected in Windows Default Apps.'
  }
}

export async function openDefaultBrowserSettings(): Promise<DefaultBrowserStatus> {
  if (process.platform !== 'win32') return getDefaultBrowserStatus()

  await registerWindowsDefaultBrowserCapabilities()

  if (getBuildMetadata().distributionChannel === 'microsoft-store') {
    await shell.openExternal('ms-settings:defaultapps')
    return getDefaultBrowserStatus()
  }

  const focusedUri = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(WINDOWS_REGISTERED_APP_NAME)}`
  let openedFocused = true
  try {
    await shell.openExternal(focusedUri)
  } catch {
    openedFocused = false
  }
  if (!openedFocused) {
    await shell.openExternal('ms-settings:defaultapps')
  }
  return getDefaultBrowserStatus()
}
