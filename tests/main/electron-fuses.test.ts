import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { REQUIRED_ELECTRON_FUSES, assertFuseState, fuseConfig, packagedElectronPath } = require('../../scripts/electron-fuses.cjs') as {
  REQUIRED_ELECTRON_FUSES: Record<string, boolean>
  assertFuseState: (path: string, fuses: unknown) => Promise<void>
  fuseConfig: (fuses: { FuseVersion: { V1: string }; FuseV1Options: Record<string, number> }, platform: string, arch: string | number) => Record<string | number, unknown>
  packagedElectronPath: (context: unknown) => string
}
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { build?: { asar?: boolean; afterPack?: string } }

test('release packaging applies the complete hardened Electron fuse profile before signing', () => {
  assert.equal(pkg.build?.asar, true)
  assert.equal(pkg.build?.afterPack, 'scripts/after-pack-hardening.cjs')
  assert.deepEqual(REQUIRED_ELECTRON_FUSES, {
    RunAsNode: false,
    EnableCookieEncryption: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: true,
    WasmTrapHandlers: true
  })
})

test('fuse configuration is strict and resolves every named fuse', () => {
  const names = Object.keys(REQUIRED_ELECTRON_FUSES)
  const options = Object.fromEntries(names.map((name, index) => [name, index]))
  const config = fuseConfig({ FuseVersion: { V1: '1' }, FuseV1Options: options }, 'darwin', 'arm64')
  assert.equal(config.version, '1')
  assert.equal(config.strictlyRequireAllFuses, true)
  assert.equal(config.resetAdHocDarwinSignature, true)
  for (const [name, expected] of Object.entries(REQUIRED_ELECTRON_FUSES)) assert.equal(config[options[name]], expected)
})

test('post-flip verification reads FuseState values from the packaged binary', async () => {
  const names = Object.keys(REQUIRED_ELECTRON_FUSES)
  const options = Object.fromEntries(names.map((name, index) => [name, index]))
  const FuseState = { ENABLE: 49, DISABLE: 48 }
  const current = Object.fromEntries(Object.entries(REQUIRED_ELECTRON_FUSES).map(([name, enabled]) => [options[name], enabled ? FuseState.ENABLE : FuseState.DISABLE]))
  const fuses = {
    FuseState,
    FuseV1Options: options,
    getCurrentFuseWire: async () => current
  }
  await assert.doesNotReject(assertFuseState('Vast.exe', fuses))
  current[options.RunAsNode] = FuseState.ENABLE
  await assert.rejects(assertFuseState('Vast.exe', fuses), /RunAsNode/)
})

test('afterPack resolves the packaged executable rather than a source Electron binary', () => {
  const context = {
    appOutDir: 'C:\\release\\win-unpacked',
    packager: {
      platform: { nodeName: 'win32' },
      appInfo: { productFilename: 'Vast' }
    }
  }
  assert.equal(packagedElectronPath(context), 'C:\\release\\win-unpacked\\Vast.exe')
})
