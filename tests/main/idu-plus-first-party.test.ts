import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ExtensionManager } from '../../src/main/extensions/extension-manager.ts'
import { chromeExtensionId, validateExtensionManifest } from '../../src/main/extensions/extension-manifest.ts'
import type { ExtensionSessionLike } from '../../src/main/extensions/extension-types.ts'
import type { Workspace } from '../../src/shared/types.ts'

const bundledRoot = resolve('resources/first-party-extensions')
const iduPlusRoot = join(bundledRoot, 'idu-plus')
const IDU_PLUS_FIRST_PARTY_EXTENSION_ID = 'kbbfoeemomglhdhohnkcnfnpikedcoka'
const expectedHost = 'https://*.idu.edu.pl/*'

interface FakeExtensionRuntime extends ExtensionSessionLike {
  loadCalls: string[]
  removeCalls: string[]
}

function workspace(id: string): Pick<Workspace, 'id' | 'isPrivate' | 'identity'> {
  return {
    id,
    isPrivate: false,
    identity: { sessionMode: 'isolated', proxyMode: 'system', proxyServer: '', proxyBypassRules: '<local>' }
  }
}

function fakeRuntime(): FakeExtensionRuntime {
  const loaded = new Map<string, Electron.Extension>()
  const runtime: FakeExtensionRuntime = {
    loadCalls: [],
    removeCalls: [],
    isPersistent: () => true,
    extensions: {
      async loadExtension(path) {
        runtime.loadCalls.push(path)
        const validated = await validateExtensionManifest(path)
        const id = chromeExtensionId(validated.rootPath, validated.manifest.key)
        const extension = { id, name: validated.manifest.name, version: validated.manifest.version, path } as Electron.Extension
        loaded.set(id, extension)
        return extension
      },
      removeExtension(id) {
        runtime.removeCalls.push(id)
        loaded.delete(id)
      },
      getExtension(id) {
        return loaded.get(id) ?? null
      }
    }
  }
  return runtime
}

async function catalogServer(state: { published: boolean; version: string }): Promise<{ origin: string; close: () => Promise<void> }> {
  const item = () => ({
    id: IDU_PLUS_FIRST_PARTY_EXTENSION_ID,
    slug: 'idu-plus',
    name: 'IDU+',
    summary: 'Improves the interface and usability of IDU school portals.',
    publisher: { id: 'publisher_vastbrowserofficial', name: 'Vast', verified: true },
    category: 'Education',
    kind: 'chrome',
    version: state.version,
    updatedAt: '2026-08-24T00:00:00.000Z',
    downloads: 0,
    installed: false
  })
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    if (request.url?.startsWith('/v1/catalog')) {
      const items = state.published ? [item()] : []
      response.end(JSON.stringify({ items, page: 1, pageSize: 24, total: items.length, featured: items, categories: ['Education'] }))
      return
    }
    if (request.url === `/v1/extensions/${IDU_PLUS_FIRST_PARTY_EXTENSION_ID}` && state.published) {
      response.end(JSON.stringify({ ...item(), description: 'IDU+ for every IDU school portal.', screenshots: [], permissions: { chrome: ['storage'], hosts: [expectedHost], vast: [] } }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'Not found' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('IDU+ has a production-scoped, private, document-start package contract', async () => {
  const manifest = JSON.parse(await readFile(join(iduPlusRoot, 'manifest.json'), 'utf8')) as {
    name: string
    version: string
    permissions: string[]
    content_scripts: Array<{ matches: string[]; css: string[]; js: string[]; run_at: string }>
    web_accessible_resources: Array<{ matches: string[]; resources: string[] }>
  }
  const runtime = await readFile(join(iduPlusRoot, 'src', 'idu-plus.js'), 'utf8')
  const popup = await readFile(join(iduPlusRoot, 'src', 'popup.js'), 'utf8')
  const styles = await readFile(join(iduPlusRoot, 'src', 'idu-plus.css'), 'utf8')
  const addressBar = await readFile(resolve('src/renderer/components/browser/AddressBar.tsx'), 'utf8')
  const webviewSurface = await readFile(resolve('src/renderer/components/browser/WebviewSurface.tsx'), 'utf8')
  const extensionsPage = await readFile(resolve('src/renderer/components/extensions/ExtensionsPage.tsx'), 'utf8')
  const extensionsToolbar = await readFile(resolve('src/renderer/components/browser/ExtensionsToolbarMenu.tsx'), 'utf8')
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { build?: { extraResources?: Array<{ from?: string; to?: string }> } }

  assert.equal(manifest.name, 'IDU+')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(manifest.permissions, ['storage'])
  assert.deepEqual(manifest.content_scripts, [{
    matches: [expectedHost],
    css: ['src/idu-plus.css'],
    js: ['src/idu-plus.js'],
    run_at: 'document_start'
  }])
  assert.deepEqual(manifest.web_accessible_resources.map((entry) => entry.matches), [[expectedHost]])
  assert.equal(runtime.includes('<all_urls>'), false)
  assert.equal(runtime.includes('workers.dev'), false)
  assert.equal(runtime.includes('sendBeacon'), false)
  assert.equal(runtime.includes('XMLHttpRequest'), false)
  assert.equal((runtime.match(/\bfetch\(/g) ?? []).length, 1)
  assert.equal(popup.includes('activeTab'), false)
  assert.equal(popup.includes('tabs.query'), false)
  assert.match(runtime, /storage\?\.local/)
  assert.equal(runtime.includes('storage.sync'), false)
  assert.match(popup, /storage\?\.local/)
  assert.equal(popup.includes('storage.sync'), false)
  assert.equal((runtime.match(/new MutationObserver/g) ?? []).length, 2)
  assert.equal((runtime.match(/new IntersectionObserver/g) ?? []).length, 1)
  assert.equal(runtime.includes('setInterval('), false)
  assert.match(runtime, /fetch\(api\.runtime\.getURL\(asset\.path\)/)
  assert.match(runtime, /dynamicContentObserver\?\.disconnect\(\)/)
  assert.match(runtime, /root\.classList\.contains\("idu-plus"\)/)
  assert.match(runtime, /root\.dataset\.iduPlusRuntime = "active"/)
  assert.match(styles, /html\.idu-plus/)
  assert.match(styles, /prefers-reduced-motion:\s*reduce/)
  assert.equal(addressBar.includes('IDU skin'), false)
  assert.equal(addressBar.includes('siteOverride'), false)
  assert.equal(webviewSurface.includes('siteOverride'), false)
  assert.match(extensionsPage, /From Vast Extensions/)
  assert.equal(extensionsPage.includes('>First-party<'), false)
  assert.match(extensionsPage, /extension\.removable/)
  assert.match(extensionsToolbar, /Active on this site/)
  assert.match(extensionsToolbar, /actionExtension\.removable/)
  assert.equal(packageJson.build?.extraResources?.some((entry) => entry.from === 'resources/first-party-extensions' && entry.to === 'first-party-extensions'), false)
})

test('Explore mirrors the Hub catalog without injecting or shadowing a bundled IDU+ entry', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'vast-idu-plus-'))
  const state = { published: false, version: '0.3.8' }
  const hub = await catalogServer(state)
  const manager = new ExtensionManager({
    userDataRoot,
    hubOrigin: hub.origin,
    sessionProvider: () => fakeRuntime()
  })

  try {
    await manager.initialize([workspace('one')])
    assert.equal((await manager.list()).some((extension) => extension.id === IDU_PLUS_FIRST_PARTY_EXTENSION_ID), false)
    assert.deepEqual((await manager.catalog({ page: 1 })).items, [])

    state.published = true
    const available = (await manager.catalog({ page: 1 })).items.find((item) => item.id === IDU_PLUS_FIRST_PARTY_EXTENSION_ID)
    assert.ok(available)
    assert.equal(available.name, 'IDU+')
    assert.equal(available.publisher.name, 'Vast')
    assert.equal(available.publisher.verified, true)
    assert.equal(available.category, 'Education')
    assert.equal(available.installed, false)
    assert.equal((await manager.catalog({ page: 1 })).items.length, 1)
    const details = await manager.catalogDetails(available.id)
    assert.deepEqual(details.permissions, { chrome: ['storage'], hosts: [expectedHost], vast: [] })

    const localInstallation = await manager.installUnpacked(iduPlusRoot)
    assert.equal(localInstallation.id, IDU_PLUS_FIRST_PARTY_EXTENSION_ID)
    assert.equal((await manager.catalog({ page: 1 })).items[0]?.installed, true)

    state.version = '0.3.9'
    assert.equal((await manager.catalog({ page: 1 })).items[0]?.version, '0.3.9')
  } finally {
    await hub.close()
    await rm(userDataRoot, { recursive: true, force: true })
  }
})

test('a Hub-installed IDU+ loads in every persistent workspace and refreshes matching tabs on lifecycle changes', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'vast-idu-plus-hub-runtime-'))
  const registryDirectory = join(userDataRoot, 'Extensions')
  const sessions = new Map<string, FakeExtensionRuntime>()
  const reloads: string[][] = []
  const now = Date.now()
  try {
    await mkdir(registryDirectory, { recursive: true })
    await writeFile(join(registryDirectory, 'registry.json'), JSON.stringify({
      schemaVersion: 5,
      extensions: [{
        id: IDU_PLUS_FIRST_PARTY_EXTENSION_ID,
        name: 'IDU+',
        version: '0.3.8',
        description: 'Improves the interface and usability of IDU school portals.',
        path: iduPlusRoot,
        enabled: true,
        source: 'hub',
        trust: 'official',
        publisherId: 'publisher_vastbrowserofficial',
        publisherName: 'Vast',
        category: 'Education',
        updateState: 'up-to-date',
        runtime: 'chrome',
        manifestVersion: 3,
        installedAt: now,
        updatedAt: now,
        allowFileAccess: false,
        grantedPermissions: []
      }]
    }), 'utf8')
    const manager = new ExtensionManager({
      userDataRoot,
      hubOrigin: 'http://127.0.0.1:1',
      reloadMatchingTabs: (patterns) => { reloads.push([...patterns]) },
      sessionProvider: (partition) => {
        let runtime = sessions.get(partition)
        if (!runtime) {
          runtime = fakeRuntime()
          sessions.set(partition, runtime)
        }
        return runtime
      }
    })
    await manager.initialize([workspace('one'), workspace('two')])
    const installed = (await manager.list()).find((extension) => extension.id === IDU_PLUS_FIRST_PARTY_EXTENSION_ID)
    assert.equal(installed?.source, 'hub')
    assert.equal(installed?.firstParty, false)
    assert.equal(installed?.loadedSessionCount, 2)
    assert.deepEqual([...sessions.values()].map((runtime) => runtime.loadCalls.length), [1, 1])

    assert.equal((await manager.disable(IDU_PLUS_FIRST_PARTY_EXTENSION_ID)).enabled, false)
    assert.deepEqual(reloads, [[expectedHost]])
    assert.equal((await manager.enable(IDU_PLUS_FIRST_PARTY_EXTENSION_ID)).enabled, true)
    assert.deepEqual(reloads, [[expectedHost], [expectedHost]])
    assert.equal(await manager.remove(IDU_PLUS_FIRST_PARTY_EXTENSION_ID), true)
    assert.deepEqual(reloads, [[expectedHost], [expectedHost], [expectedHost]])
    assert.equal((await manager.list()).length, 0)
  } finally {
    await rm(userDataRoot, { recursive: true, force: true })
  }
})

test('migrates the previous auto-installed IDU+ record back to Explore', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'vast-idu-plus-migration-'))
  const registryDirectory = join(userDataRoot, 'Extensions')
  const now = Date.now()
  try {
    await mkdir(registryDirectory, { recursive: true })
    await writeFile(join(registryDirectory, 'registry.json'), JSON.stringify({
      schemaVersion: 4,
      extensions: [{
        id: IDU_PLUS_FIRST_PARTY_EXTENSION_ID,
        name: 'IDU+',
        version: '0.3.7',
        path: iduPlusRoot,
        enabled: true,
        source: 'bundled',
        trust: 'official',
        publisherName: 'Vast',
        category: 'Education',
        updateState: 'not-applicable',
        runtime: 'chrome',
        manifestVersion: 3,
        installedAt: now,
        updatedAt: now,
        allowFileAccess: false,
        grantedPermissions: []
      }]
    }), 'utf8')
    const manager = new ExtensionManager({
      userDataRoot,
      hubOrigin: 'http://127.0.0.1:1',
      sessionProvider: () => fakeRuntime()
    })
    await manager.initialize([workspace('one')])
    assert.equal((await manager.list()).some((extension) => extension.id === IDU_PLUS_FIRST_PARTY_EXTENSION_ID), false)
    const persisted = JSON.parse(await readFile(join(registryDirectory, 'registry.json'), 'utf8')) as { schemaVersion: number; extensions: unknown[] }
    assert.equal(persisted.schemaVersion, 5)
    assert.equal(persisted.extensions.length, 0)
  } finally {
    await rm(userDataRoot, { recursive: true, force: true })
  }
})
