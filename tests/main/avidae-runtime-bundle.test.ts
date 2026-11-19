import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyAvidaeRuntime } from '../../src/main/avidae-runtime.ts'

const expected = { moduleVersion: '1.0.0', hostApi: 1 }

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture(): Promise<{ resources: string; root: string; manifestPath: string }> {
  const resources = await mkdtemp(join(tmpdir(), 'vast-avidae-runtime-test-'))
  const root = join(resources, 'avidae-runtime')
  await mkdir(join(root, 'app'), { recursive: true })
  await mkdir(join(root, 'media'), { recursive: true })
  await mkdir(join(root, 'ms-playwright', 'chromium'), { recursive: true })
  const files: Record<string, string> = {
    'app/VastVideoAudio.exe': 'runtime',
    'media/ffmpeg.exe': 'ffmpeg',
    'media/ffprobe.exe': 'ffprobe',
    'avidae-ffmpeg-capabilities.json': '{"ok":true}',
    'ms-playwright/chromium/chrome.exe': 'chromium'
  }
  for (const [relativePath, value] of Object.entries(files)) {
    await writeFile(join(root, ...relativePath.split('/')), value)
  }
  const sourceBundle = { fileName: 'ffmpeg-corresponding-source-win64.tar.zst', sha256: digest('source-bundle'), size: 'source-bundle'.length } as const
  files['ffmpeg-build-provenance.json'] = JSON.stringify({
    licenseMode: 'gpl-3.0-or-later',
    ffmpeg: { sha256: digest(files['media/ffmpeg.exe']) },
    ffprobe: { sha256: digest(files['media/ffprobe.exe']) },
    capabilityReport: { sha256: digest(files['avidae-ffmpeg-capabilities.json']), size: files['avidae-ffmpeg-capabilities.json'].length },
    sourceBundle
  })
  await writeFile(join(root, 'ffmpeg-build-provenance.json'), files['ffmpeg-build-provenance.json'])
  const manifestPath = join(root, 'runtime-manifest.json')
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 4,
    moduleId: 'vast-video-audio',
    moduleVersion: '1.0.0',
    hostApi: 1,
    runtimeVersion: 'test-runtime',
    files: Object.keys(files).sort().map((path) => ({ path, sha256: digest(files[path]), size: files[path].length })),
    executable: { path: 'app/VastVideoAudio.exe', sha256: digest(files['app/VastVideoAudio.exe']), size: files['app/VastVideoAudio.exe'].length },
    ffmpeg: { path: 'media/ffmpeg.exe', sha256: digest(files['media/ffmpeg.exe']), size: files['media/ffmpeg.exe'].length },
    ffprobe: { path: 'media/ffprobe.exe', sha256: digest(files['media/ffprobe.exe']), size: files['media/ffprobe.exe'].length },
    ffmpegProvenance: { path: 'ffmpeg-build-provenance.json', sha256: digest(files['ffmpeg-build-provenance.json']), size: files['ffmpeg-build-provenance.json'].length },
    ffmpegCapabilities: { path: 'avidae-ffmpeg-capabilities.json', sha256: digest(files['avidae-ffmpeg-capabilities.json']), size: files['avidae-ffmpeg-capabilities.json'].length },
    ffmpegSourceBundle: sourceBundle,
    browser: {
      engine: 'chromium',
      distribution: 'playwright-chromium',
      headlessMode: 'new',
      executable: { path: 'ms-playwright/chromium/chrome.exe', sha256: digest(files['ms-playwright/chromium/chrome.exe']), size: files['ms-playwright/chromium/chrome.exe'].length }
    },
    playwrightBrowsersPath: 'ms-playwright'
  }))
  return { resources, root, manifestPath }
}

test('packaged Video & Audio runtime verifies every executable before use', async () => {
  const item = await fixture()
  try {
    const runtime = await verifyAvidaeRuntime(item.root, expected)
    assert.equal(runtime.label, 'Video & Audio module 1.0.0 (test-runtime)')
    assert.equal(runtime.executable, join(item.root, 'app', 'VastVideoAudio.exe'))
    assert.equal(runtime.chromiumExecutable, join(item.root, 'ms-playwright', 'chromium', 'chrome.exe'))
    await writeFile(runtime.ffmpeg, 'evil!!')
    await assert.rejects(() => verifyAvidaeRuntime(item.root, expected), /FFmpeg failed its integrity check/)
  } finally {
    await rm(item.resources, { recursive: true, force: true })
  }
})

test('packaged Video & Audio ignores an unreferenced headless shell left by an older installer', async () => {
  const item = await fixture()
  try {
    await mkdir(join(item.root, 'ms-playwright', 'chromium_headless_shell-1234'), { recursive: true })
    const runtime = await verifyAvidaeRuntime(item.root, expected)
    assert.equal(runtime.chromiumExecutable, join(item.root, 'ms-playwright', 'chromium', 'chrome.exe'))
  } finally {
    await rm(item.resources, { recursive: true, force: true })
  }
})

test('installed Video & Audio runtime must match its installation record and inventory', async () => {
  const item = await fixture()
  try {
    await assert.rejects(() => verifyAvidaeRuntime(item.root, { moduleVersion: '1.0.1', hostApi: 1 }), /installation record/)
    await assert.rejects(() => verifyAvidaeRuntime(item.root, { moduleVersion: '1.0.0', hostApi: 2 }), /installation record/)
    await rm(join(item.root, 'ms-playwright', 'chromium', 'chrome.exe'))
    await assert.rejects(() => verifyAvidaeRuntime(item.root, expected), /missing or changed/)
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
    await assert.rejects(() => verifyAvidaeRuntime(item.root, expected), /unsafe path/)
  } finally {
    await rm(item.resources, { recursive: true, force: true })
  }
})
