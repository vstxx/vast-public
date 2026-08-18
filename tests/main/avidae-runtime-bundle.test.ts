import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyBundledAvidaeRuntime } from '../../src/main/avidae-runtime.ts'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture(): Promise<{ resources: string; root: string; manifestPath: string }> {
  const resources = await mkdtemp(join(tmpdir(), 'vast-avidae-runtime-test-'))
  const root = join(resources, 'avidae-runtime')
  await mkdir(join(root, 'app'), { recursive: true })
  await mkdir(join(root, 'media'), { recursive: true })
  await mkdir(join(root, 'ms-playwright', 'chromium'), { recursive: true })
  const files = {
    'app/VastVideoAudio.exe': 'runtime',
    'media/ffmpeg.exe': 'ffmpeg',
    'media/ffprobe.exe': 'ffprobe',
    'ms-playwright/chromium/chrome.exe': 'chromium'
  }
  for (const [relativePath, value] of Object.entries(files)) {
    await writeFile(join(root, ...relativePath.split('/')), value)
  }
  const manifestPath = join(root, 'runtime-manifest.json')
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: 'test-runtime',
    executable: { path: 'app/VastVideoAudio.exe', sha256: digest(files['app/VastVideoAudio.exe']) },
    ffmpeg: { path: 'media/ffmpeg.exe', sha256: digest(files['media/ffmpeg.exe']) },
    ffprobe: { path: 'media/ffprobe.exe', sha256: digest(files['media/ffprobe.exe']) },
    chromium: { path: 'ms-playwright/chromium/chrome.exe', sha256: digest(files['ms-playwright/chromium/chrome.exe']) },
    playwrightBrowsersPath: 'ms-playwright'
  }))
  return { resources, root, manifestPath }
}

test('packaged Video & Audio runtime verifies every executable before use', async () => {
  const item = await fixture()
  try {
    const runtime = await verifyBundledAvidaeRuntime(item.resources)
    assert.equal(runtime.label, 'Bundled runtime test-runtime')
    assert.equal(runtime.executable, join(item.root, 'app', 'VastVideoAudio.exe'))
    await writeFile(runtime.ffmpeg, 'tampered')
    await assert.rejects(() => verifyBundledAvidaeRuntime(item.resources), /FFmpeg failed its integrity check/)
  } finally {
    await rm(item.resources, { recursive: true, force: true })
  }
})

test('packaged Video & Audio runtime rejects path traversal in its manifest', async () => {
  const item = await fixture()
  try {
    const manifest = JSON.parse(await readFile(item.manifestPath, 'utf8'))
    manifest.executable.path = '../outside.exe'
    await writeFile(item.manifestPath, JSON.stringify(manifest))
    await assert.rejects(() => verifyBundledAvidaeRuntime(item.resources), /unsafe path/)
  } finally {
    await rm(item.resources, { recursive: true, force: true })
  }
})
