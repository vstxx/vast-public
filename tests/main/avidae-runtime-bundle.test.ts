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
    schemaVersion: 3,
    runtimeVersion: 'test-runtime',
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
    const runtime = await verifyBundledAvidaeRuntime(item.resources)
    assert.equal(runtime.label, 'Bundled runtime test-runtime')
    assert.equal(runtime.executable, join(item.root, 'app', 'VastVideoAudio.exe'))
    assert.equal(runtime.chromiumExecutable, join(item.root, 'ms-playwright', 'chromium', 'chrome.exe'))
    await writeFile(runtime.ffmpeg, 'evil!!')
    await assert.rejects(() => verifyBundledAvidaeRuntime(item.resources), /FFmpeg failed its integrity check/)
  } finally {
    await rm(item.resources, { recursive: true, force: true })
  }
})

test('packaged Video & Audio rejects a redundant Playwright headless shell', async () => {
  const item = await fixture()
  try {
    await mkdir(join(item.root, 'ms-playwright', 'chromium_headless_shell-1234'), { recursive: true })
    await assert.rejects(() => verifyBundledAvidaeRuntime(item.resources), /redundant headless shell/)
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
