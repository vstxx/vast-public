import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromeExtensionId, validateExtensionManifest } from '../../src/main/extensions/extension-manifest.ts'
import { stageLocalChromiumDirectory } from '../../src/main/extensions/local-chromium-stage.ts'
import { validateLocalChromiumStage } from '../../src/main/extensions/local-chromium-validation.ts'

const key = Buffer.alloc(128, 7).toString('base64')
const id = chromeExtensionId('unused', key)

async function fixture(manifest: Record<string, unknown>): Promise<{ root: string; source: string; staging: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vast-local-validation-'))
  const source = join(root, 'Chrome', 'Default', 'Extensions', id, '1.0.0_0')
  const staging = join(root, 'Vast', 'Staging')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ name: 'Controlled', version: '1.0.0', ...manifest }))
  return { root, source, staging }
}

async function validate(source: string, staging: string, sourceId = id) {
  const stage = await stageLocalChromiumDirectory({ sourceRoot: source, stagingRoot: staging,
    sourceExtensionId: sourceId, expectedVersion: '1.0.0' }, new AbortController().signal)
  return validateLocalChromiumStage(stage, sourceId)
}

test('accepts keyed MV3 without modifying source and requests no Vast-native grants', async () => {
  const data = await fixture({ manifest_version: 3, key, permissions: ['storage'], host_permissions: ['https://example.com/*'] })
  try {
    const before = await readFile(join(data.source, 'manifest.json'))
    const result = await validate(data.source, data.staging)
    assert.equal(result.runtimeId, id)
    assert.deepEqual(result.permissions, { chrome: ['storage'], hosts: ['https://example.com/*'], vast: [] })
    assert.deepEqual(await readFile(join(data.source, 'manifest.json')), before)
  } finally { await rm(data.root, { recursive: true, force: true }) }
})

test('permits ordinary keyed MV2 only in the local Chromium validation path', async () => {
  const data = await fixture({ manifest_version: 2, key, background: { scripts: ['background.js'] }, permissions: ['storage'] })
  try {
    await writeFile(join(data.source, 'background.js'), 'globalThis.controlled = true')
    await assert.rejects(validateExtensionManifest(data.source), /Manifest V2 is restricted/i)
    const result = await validate(data.source, data.staging)
    assert.equal(result.validated.manifest.manifest_version, 2)
    assert.equal(result.runtimeId, id)
  } finally { await rm(data.root, { recursive: true, force: true }) }
})

test('rejects absent, malformed and mismatched keys rather than changing the runtime ID', async () => {
  for (const value of [undefined, 'not-base64!', Buffer.alloc(128, 9).toString('base64')]) {
    const data = await fixture({ manifest_version: 3, ...(value ? { key: value } : {}) })
    try {
      await assert.rejects(validate(data.source, data.staging), /public key|original ID/i)
    } finally { await rm(data.root, { recursive: true, force: true }) }
  }
})

test('rejects Vast-native capability claims, missing content script assets and staged-file tampering', async () => {
  const privileged = await fixture({ manifest_version: 3, key, vast_network: 1 })
  try { await assert.rejects(validate(privileged.source, privileged.staging), /Vast-native/i) }
  finally { await rm(privileged.root, { recursive: true, force: true }) }

  const missing = await fixture({ manifest_version: 3, key,
    content_scripts: [{ matches: ['https://example.com/*'], js: ['missing.js'] }] })
  try { await assert.rejects(validate(missing.source, missing.staging), /ENOENT|file/i) }
  finally { await rm(missing.root, { recursive: true, force: true }) }

  const missingBackground = await fixture({ manifest_version: 3, key, background: { service_worker: 'missing.js' } })
  try { await assert.rejects(validate(missingBackground.source, missingBackground.staging), /ENOENT|file/i) }
  finally { await rm(missingBackground.root, { recursive: true, force: true }) }

  const unsafeCsp = await fixture({ manifest_version: 3, key, content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } })
  try { await assert.rejects(validate(unsafeCsp.source, unsafeCsp.staging), /policy is unsafe/i) }
  finally { await rm(unsafeCsp.root, { recursive: true, force: true }) }

  const tampered = await fixture({ manifest_version: 3, key })
  try {
    const stage = await stageLocalChromiumDirectory({ sourceRoot: tampered.source, stagingRoot: tampered.staging,
      sourceExtensionId: id, expectedVersion: '1.0.0' }, new AbortController().signal)
    await writeFile(join(stage.contentRoot, 'manifest.json'), '{}')
    await assert.rejects(validateLocalChromiumStage(stage, id), /changed/i)
  } finally { await rm(tampered.root, { recursive: true, force: true }) }
})
