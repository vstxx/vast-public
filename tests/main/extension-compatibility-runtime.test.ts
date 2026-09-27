import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BrowserWindow, Extension, Session, WebContents } from 'electron/main'
import {
  ECE_GPL_LICENSE,
  ExtensionCompatibilityRuntime,
  extensionCompatibilityGate,
  isDeclaredOptionalPermissionRequest,
  type ChromePermissionRequest
} from '../../src/main/extensions/extension-compatibility-runtime.ts'
import * as compatibilityRuntimeModule from '../../src/main/extensions/extension-compatibility-runtime.ts'
import type { BrowserTabOpenRequest, ExtensionCompatibilityTabCommand } from '../../src/shared/types.ts'

const require = createRequire(import.meta.url)
const compatibilityManifest = require('../../patches/extension-compatibility-runtime.json')

function packagedEvidence() {
  const fingerprint = {
    schemaVersion: 2,
    manifest: 'patches/extension-compatibility-runtime.json',
    electronVersion: compatibilityManifest.electron.version,
    electronPatchsetRevision: compatibilityManifest.electron.patchsetRevision,
    electronPatchsetSha256: compatibilityManifest.electron.patchsetSha256,
    electronBinarySha256: compatibilityManifest.electron.binary.sha256,
    eceVersion: compatibilityManifest.ece.version,
    ecePatchSha256: compatibilityManifest.ece.patchSha256,
    eceRuntimeSha256: compatibilityManifest.ece.runtimeSha256,
    vastSourceCommit: 'a'.repeat(40),
    vastDirty: false,
    releaseMode: true
  }
  return {
    fingerprint,
    releaseMetadata: {
      version: '0.4.0',
      sourceCommit: fingerprint.vastSourceCommit,
      extensionCompatibilityRuntime: fingerprint
    },
    distributionMarker: {
      schemaVersion: 1,
      electronVersion: compatibilityManifest.electron.version,
      patchsetRevision: compatibilityManifest.electron.patchsetRevision,
      patchsetSha256: compatibilityManifest.electron.patchsetSha256,
      electronBinarySha256: compatibilityManifest.electron.binary.sha256
    }
  }
}

function packagedGateInput() {
  return {
    isPackaged: true,
    appVersion: '0.4.0',
    electronVersion: '44.3.0',
    executablePath: 'C:\\Program Files\\Vast\\Vast.exe',
    env: {},
    approvedRuntime: compatibilityManifest,
    packagedEvidence: packagedEvidence()
  }
}

function enabledGate() {
  return extensionCompatibilityGate({
    isPackaged: false,
    electronVersion: '44.3.0',
    executablePath: 'D:\\patched\\electron.exe',
    env: {
      VAST_EXTENSION_COMPATIBILITY: '1',
      VAST_PATCHED_ELECTRON_COMPAT: '1',
      VAST_PATCHED_ELECTRON_DIST: 'D:\\patched'
    }
  })
}

test('compatibility gate requires development, the validated Electron base and executable path, and selects GPL', () => {
  assert.equal(enabledGate().enabled, true)
  assert.equal(enabledGate().license, ECE_GPL_LICENSE)
  assert.equal(extensionCompatibilityGate({ ...enabledGateInput(), isPackaged: true }).enabled, false)
  assert.equal(extensionCompatibilityGate({ ...enabledGateInput(), electronVersion: '45.0.0' }).enabled, false)
  assert.equal(extensionCompatibilityGate({ ...enabledGateInput(), executablePath: 'D:\\stock\\electron.exe' }).enabled, false)
  assert.deepEqual(extensionCompatibilityGate({
    ...enabledGateInput(),
    env: { ...enabledGateInput().env, VAST_EXTENSION_COMPATIBILITY_DISABLE: '1' }
  }), { enabled: false, reason: 'internal rollback switch is on' })
})

test('packaged compatibility gate accepts only the exact release attestation and selects GPL', () => {
  assert.deepEqual(extensionCompatibilityGate(packagedGateInput()), {
    enabled: true,
    reason: 'verified packaged compatibility runtime',
    license: ECE_GPL_LICENSE
  })
})

test('packaged compatibility gate rejects tampered fingerprints and distribution markers', () => {
  const tamperedFingerprint = packagedEvidence()
  tamperedFingerprint.fingerprint.eceRuntimeSha256 = 'f'.repeat(64)
  tamperedFingerprint.releaseMetadata.extensionCompatibilityRuntime = tamperedFingerprint.fingerprint
  assert.match(extensionCompatibilityGate({
    ...packagedGateInput(),
    packagedEvidence: tamperedFingerprint
  }).reason, /fingerprint/i)

  const tamperedMarker = packagedEvidence()
  tamperedMarker.distributionMarker.patchsetRevision = 'wrong'
  assert.match(extensionCompatibilityGate({
    ...packagedGateInput(),
    packagedEvidence: tamperedMarker
  }).reason, /distribution marker/i)

  const mismatchedSource = packagedEvidence()
  mismatchedSource.releaseMetadata.sourceCommit = 'b'.repeat(40)
  assert.match(extensionCompatibilityGate({
    ...packagedGateInput(),
    packagedEvidence: mismatchedSource
  }).reason, /source commit/i)
})

test('internal rollback switch overrides a valid packaged compatibility attestation', () => {
  assert.deepEqual(extensionCompatibilityGate({
    ...packagedGateInput(),
    env: { VAST_EXTENSION_COMPATIBILITY_DISABLE: '1' }
  }), { enabled: false, reason: 'internal rollback switch is on' })
})

test('packaged compatibility evidence is read from app files and fails closed when incomplete', async (t) => {
  assert.equal(typeof compatibilityRuntimeModule.readPackagedCompatibilityEvidence, 'function')
  const root = await mkdtemp(join(tmpdir(), 'vast-packaged-compatibility-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appPath = join(root, 'resources', 'app.asar')
  const executablePath = join(root, 'Vast.exe')
  await mkdir(join(appPath, 'out'), { recursive: true })
  const evidence = packagedEvidence()
  await writeFile(join(appPath, 'out', 'extension-compatibility-runtime-fingerprint.json'), JSON.stringify(evidence.fingerprint))
  await writeFile(join(appPath, 'out', 'release-build-metadata.json'), JSON.stringify(evidence.releaseMetadata))
  await writeFile(join(root, '.vast-electron-dist.json'), JSON.stringify(evidence.distributionMarker))

  assert.deepEqual(compatibilityRuntimeModule.readPackagedCompatibilityEvidence({ appPath, executablePath }), {
    evidence
  })
  await rm(join(root, '.vast-electron-dist.json'))
  assert.match(
    compatibilityRuntimeModule.readPackagedCompatibilityEvidence({ appPath, executablePath }).error ?? '',
    /distribution marker/i
  )
})

test('runtime initialization failure latches fail-closed for every later session', async () => {
  let attempts = 0
  const runtime = new ExtensionCompatibilityRuntime({
    gate: enabledGate(),
    loadEce: async () => { attempts += 1; throw new Error('broken ECE runtime') },
    focusedWindow: () => undefined,
    windowById: () => undefined,
    dispatchTabOpen: () => false,
    dispatchTabCommand: () => undefined,
    dispatchPopupOpen: () => false
  })

  await assert.rejects(runtime.prepareSession({} as Session), /compatibility layer is disabled/i)
  await assert.rejects(runtime.prepareSession({} as Session), /compatibility layer is disabled/i)
  assert.equal(attempts, 1)
  assert.equal(runtime.enabled, false)
  assert.equal(runtime.reason, 'disabled after compatibility runtime initialization failure')
})

test('a later session failure rejects pending work and disables every existing adapter callback', async () => {
  const firstSession = {} as Session
  const secondSession = {} as Session
  const targetWindow = { id: 1, isDestroyed: () => false } as unknown as BrowserWindow
  let constructorCount = 0
  let firstOptions: Record<string, unknown> | undefined
  class PartiallyFailingEce {
    constructor(options: Record<string, unknown>) {
      constructorCount += 1
      if (constructorCount === 2) throw new Error('second session failed')
      firstOptions = options
    }
    addTab(): void {}
    removeTab(): void {}
    selectTab(): void {}
  }
  const runtime = new ExtensionCompatibilityRuntime({
    gate: enabledGate(),
    loadEce: async () => ({ ElectronChromeExtensions: PartiallyFailingEce }),
    focusedWindow: () => targetWindow,
    windowById: () => targetWindow,
    dispatchTabOpen: () => true,
    dispatchTabCommand: () => undefined,
    dispatchPopupOpen: () => false,
    getGrantedPermissions: () => ({ permissions: ['privacy'], origins: [] }),
    persistGrantedPermissions: async () => true,
    removeGrantedPermissions: async () => true,
    tabCreationTimeoutMs: 5_000
  })
  await runtime.prepareSession(firstSession)
  const pendingTab = (firstOptions?.createTab as (details: object) => Promise<unknown>)({})

  await assert.rejects(runtime.prepareSession(secondSession), /compatibility layer is disabled/i)
  await assert.rejects(pendingTab, /compatibility layer is disabled/i)
  assert.equal(runtime.enabled, false)
  assert.deepEqual((firstOptions?.getGrantedPermissions as (extension: Extension) => ChromePermissionRequest)({} as Extension), {
    permissions: [], origins: []
  })
  assert.equal(await (firstOptions?.requestPermissions as (extension: Extension, request: ChromePermissionRequest) => Promise<boolean>)(
    { manifest: { optional_permissions: ['privacy'] } } as unknown as Extension,
    { permissions: ['privacy'] }
  ), false)
  await assert.rejects(
    (firstOptions?.createTab as (details: object) => Promise<unknown>)({}),
    /compatibility layer is disabled/i
  )
})

function enabledGateInput() {
  return {
    isPackaged: false,
    electronVersion: '44.3.0',
    executablePath: 'D:\\patched\\electron.exe',
    env: {
      VAST_EXTENSION_COMPATIBILITY: '1',
      VAST_PATCHED_ELECTRON_COMPAT: '1',
      VAST_PATCHED_ELECTRON_DIST: 'D:\\patched'
    }
  }
}

test('optional permission adapter rejects undeclared and empty grants', () => {
  const extension = {
    manifest: {
      optional_permissions: ['clipboardRead', 'notifications'],
      optional_host_permissions: ['https://example.test/*']
    }
  } as unknown as Extension
  assert.equal(isDeclaredOptionalPermissionRequest(extension, { permissions: ['clipboardRead'] }), true)
  assert.equal(isDeclaredOptionalPermissionRequest(extension, { origins: ['https://example.test/*'] }), true)
  assert.equal(isDeclaredOptionalPermissionRequest(extension, { permissions: ['tabs'] }), false)
  assert.equal(isDeclaredOptionalPermissionRequest(extension, {}), false)
})

test('runtime creates one ECE instance per session and resolves Chrome tabs and action popups to the exact Vast window', async () => {
  const popupExtension = { id: 'p'.repeat(32) } as Extension
  const nativeExtensionEvents = new EventEmitter()
  const targetSession = {
    extensions: Object.assign(nativeExtensionEvents, {
      getExtension: (id: string) => id === popupExtension.id ? popupExtension : undefined
    })
  } as unknown as Session
  const targetWindow = { id: 9, isDestroyed: () => false } as unknown as BrowserWindow
  let constructorCount = 0
  let options: Record<string, unknown> | undefined
  const added: number[] = []
  let removedByAdapter = 0
  const selected: number[] = []
  const commands: ExtensionCompatibilityTabCommand[] = []
  const popupRequests: string[] = []
  let openRequest: BrowserTabOpenRequest | undefined

  class FakeEce {
    constructor(input: Record<string, unknown>) { constructorCount += 1; options = input }
    addTab(tab: WebContents): void {
      added.push(tab.id)
      ;(options?.selectTab as (tab: WebContents, window: BrowserWindow) => void)(tab, targetWindow)
    }
    removeTab(): void { removedByAdapter += 1 }
    selectTab(tab: WebContents): void {
      selected.push(tab.id)
      ;(options?.selectTab as (tab: WebContents, window: BrowserWindow) => void)(tab, targetWindow)
    }
  }

  const runtime = new ExtensionCompatibilityRuntime({
    gate: enabledGate(),
    loadEce: async () => ({ ElectronChromeExtensions: FakeEce }),
    focusedWindow: () => targetWindow,
    windowById: (id) => id === 9 ? targetWindow : undefined,
    dispatchTabOpen: (_window, request) => { openRequest = request; return true },
    dispatchTabCommand: (_window, command) => commands.push(command),
    dispatchPopupOpen: (_window, extensionId) => { popupRequests.push(extensionId); return true },
    tabCreationTimeoutMs: 1_000
  })
  await runtime.prepareSession(targetSession)
  await runtime.prepareSession(targetSession)
  assert.equal(constructorCount, 1)

  const createTab = options?.createTab as (details: { url: string; active: boolean }) => Promise<[WebContents, BrowserWindow]>
  const created = createTab({ url: 'https://example.test/onboarding', active: true })
  assert.equal(openRequest?.url, 'https://example.test/onboarding')
  assert.equal(openRequest?.activate, true)
  assert.match(openRequest?.compatibilityRequestId ?? '', /^[0-9a-f-]{36}$/i)

  const events = new EventEmitter()
  let destroyed = false
  const contents = Object.assign(events, {
    id: 42,
    session: targetSession,
    isDestroyed: () => destroyed
  }) as unknown as WebContents
  runtime.attachTab(contents, targetWindow)
  assert.deepEqual(added, [42])
  assert.deepEqual(commands, [], 'ECE must not echo Vast-owned tab attachment')
  assert.equal(runtime.confirmCreatedTab(openRequest!.compatibilityRequestId!, contents, targetWindow), true)
  assert.deepEqual(await created, [contents, targetWindow])

  runtime.selectTab(contents)
  assert.deepEqual(selected, [42])
  assert.deepEqual(commands, [], 'ECE must not echo Vast-owned tab selection')
  const openPopup = options?.openPopup as (extension: Extension, tab: WebContents, window: BrowserWindow) => Promise<boolean>
  assert.equal(await openPopup(popupExtension, contents, targetWindow), true)
  assert.deepEqual(popupRequests, [popupExtension.id])
  nativeExtensionEvents.emit('extension-action-open-popup', {}, popupExtension.id, contents.id)
  assert.deepEqual(popupRequests, [popupExtension.id, popupExtension.id])
  nativeExtensionEvents.emit('extension-action-open-popup', {}, popupExtension.id, 999)
  assert.deepEqual(popupRequests, [popupExtension.id, popupExtension.id], 'native popup events must resolve to an exact tracked tab')
  assert.equal(await openPopup({ id: 'missing' } as Extension, contents, targetWindow), false)
  const selectTab = options?.selectTab as (tab: WebContents, window: BrowserWindow) => void
  selectTab(contents, targetWindow)
  assert.deepEqual(commands, [{ action: 'select', webContentsId: 42 }])

  const removeTab = options?.removeTab as (tab: WebContents, window: BrowserWindow) => void
  removeTab(contents, targetWindow)
  assert.deepEqual(commands.at(-1), { action: 'remove', webContentsId: 42 })
  destroyed = true
  events.emit('destroyed')
  removeTab(contents, targetWindow)
  assert.equal(commands.length, 2)
  assert.equal(removedByAdapter, 0)
})

test('permission requests remain denied unless the isolated test grant flag is enabled', async () => {
  const targetSession = {} as Session
  const targetWindow = { id: 1, isDestroyed: () => false } as unknown as BrowserWindow
  const extension = { manifest: { optional_permissions: ['notifications'] } } as unknown as Extension
  for (const allowTestPermissionGrant of [false, true]) {
    let options: Record<string, unknown> | undefined
    class FakeEce {
      constructor(input: Record<string, unknown>) { options = input }
      addTab(): void {}
      removeTab(): void {}
      selectTab(): void {}
    }
    const runtime = new ExtensionCompatibilityRuntime({
      gate: enabledGate(),
      loadEce: async () => ({ ElectronChromeExtensions: FakeEce }),
      focusedWindow: () => targetWindow,
      windowById: () => targetWindow,
      dispatchTabOpen: () => true,
      dispatchTabCommand: () => undefined,
      dispatchPopupOpen: () => false,
      persistGrantedPermissions: async () => true,
      removeGrantedPermissions: async () => true,
      allowTestPermissionGrant
    })
    await runtime.prepareSession(targetSession)
    const requestPermissions = options?.requestPermissions as (extension: Extension, request: { permissions: string[] }) => Promise<boolean>
    assert.equal(await requestPermissions(extension, { permissions: ['notifications'] }), allowTestPermissionGrant)
    assert.equal(await requestPermissions(extension, { permissions: ['tabs'] }), false)
    const removePermissions = options?.removePermissions as (extension: Extension, request: { permissions: string[] }) => Promise<boolean>
    assert.equal(await removePermissions(extension, { permissions: ['notifications'] }), true)
    assert.equal(await removePermissions(extension, { permissions: ['tabs'] }), false)
  }
})

test('privacy writes require a persisted optional privacy grant and remain isolated by session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-compat-privacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const targetWindow = { id: 1, isDestroyed: () => false } as unknown as BrowserWindow
  const firstSession = { getPartition: () => 'persist:first' } as unknown as Session
  const secondSession = { getPartition: () => 'persist:second' } as unknown as Session
  const partitions = new Map<Session, string>([
    [firstSession, 'persist:first'],
    [secondSession, 'persist:second']
  ])
  const extension = {
    id: 'a'.repeat(32),
    manifest: { optional_permissions: ['privacy'] }
  } as unknown as Extension
  const constructorOptions = new Map<Session, Record<string, unknown>>()

  class FakeEce {
    constructor(input: Record<string, unknown>) {
      constructorOptions.set(input.session as Session, input)
    }
    addTab(): void {}
    removeTab(): void {}
    selectTab(): void {}
  }

  let granted: string[] = []
  const runtime = new ExtensionCompatibilityRuntime({
    gate: enabledGate(),
    loadEce: async () => ({ ElectronChromeExtensions: FakeEce }),
    focusedWindow: () => targetWindow,
    windowById: () => targetWindow,
    dispatchTabOpen: () => true,
    dispatchTabCommand: () => undefined,
    dispatchPopupOpen: () => false,
    getGrantedPermissions: () => ({ permissions: granted, origins: [] }),
    privacyStatePathForSession: (targetSession) => join(root, `${partitions.get(targetSession)!.replace(':', '-')}.json`)
  })
  await runtime.prepareSession(firstSession)
  await runtime.prepareSession(secondSession)

  const first = constructorOptions.get(firstSession)!
  const second = constructorOptions.get(secondSession)!
  const setFirst = first.setPrivacySetting as (extension: Extension, request: { key: string; value: boolean }) => Promise<unknown>
  const getFirst = first.getPrivacySetting as (extension: Extension, request: { key: string }) => Promise<{ value: boolean; levelOfControl: string }>
  const getSecond = second.getPrivacySetting as (extension: Extension, request: { key: string }) => Promise<{ value: boolean; levelOfControl: string }>

  await assert.rejects(
    setFirst(extension, { key: 'services.passwordSavingEnabled', value: false }),
    /privacy permission is not granted/
  )
  granted = ['privacy']
  await setFirst(extension, { key: 'services.passwordSavingEnabled', value: false })
  assert.deepEqual(await getFirst(extension, { key: 'services.passwordSavingEnabled' }), {
    value: false,
    controllerExtensionId: extension.id,
    updatedAt: (await getFirst(extension, { key: 'services.passwordSavingEnabled' }) as { updatedAt: string }).updatedAt,
    levelOfControl: 'controlled_by_this_extension'
  })
  assert.deepEqual(await getSecond(extension, { key: 'services.passwordSavingEnabled' }), {
    value: true,
    levelOfControl: 'controllable_by_this_extension'
  })
})
