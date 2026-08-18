import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parseCatAnimationMetadata } from '../../src/shared/cat-addon-runtime.ts'

function pngSize(path: string): { width: number; height: number } {
  const data = readFileSync(path)
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

test('Cat_Grey_White source generation is deterministic and validates all source pixels', () => {
  const result = spawnSync('python', ['tools/cat_addon/build_cat_assets.py', '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /483 source frames, 94 tags, 49 curated animations/)
})

test('generated metadata and atlas geometry are synchronized and bounded', () => {
  const metadata = parseCatAnimationMetadata(JSON.parse(readFileSync('assets/cat-addon/package/animations/animations.json', 'utf8')))
  assert.deepEqual(pngSize('assets/cat-addon/package/assets/cat_grey_white.png'), {
    width: metadata.atlas.width,
    height: metadata.atlas.height
  })
  assert.equal(metadata.source.frame_count, 483)
  assert.equal(metadata.source.tag_count, 94)
  assert.equal(metadata.animations.length, 49)
  assert.equal(metadata.animations.every((animation) => animation.frames.length > 0 && animation.frames.every((frame) => frame.duration_ms > 0)), true)
  assert.equal(metadata.animations.every((animation) => animation.frames.every((frame) => frame.x % 32 === 0 && frame.y % 32 === 0)), true)
})

test('development atlas exposes every source tag while production excludes uncurated source variants', () => {
  const source = JSON.parse(readFileSync('assets/cat-addon/generated/source-tags.json', 'utf8'))
  assert.equal(source.tags.length, 94)
  assert.equal(source.tags.every((tag: { frames: unknown[]; frame_count: number }) => tag.frames.length === tag.frame_count), true)
  assert.deepEqual(pngSize('assets/cat-addon/generated/source-atlas.png'), { width: 512, height: 992 })
  assert.equal(existsSync('assets/cat-addon/generated/contact-sheet.png'), true)
  const manifest = JSON.parse(readFileSync('assets/cat-addon/package/manifest.json', 'utf8'))
  assert.deepEqual(manifest.assets.map((asset: { path: string }) => asset.path), ['assets/cat_grey_white.png'])
  assert.equal(JSON.stringify(manifest).includes('Ginger'), false)
  assert.equal(JSON.stringify(manifest).includes('Cat_Grey.aseprite'), false)
})

test('obsolete malformed cat resources and procedural renderer are absent', () => {
  for (const path of [
    'assets/cat-addon/source/cat_source.gif',
    'assets/cat-addon/package/assets/cat_source.gif',
    'assets/cat-addon/package/assets/cat_motion.png',
    'assets/cat-addon/package/assets/cat_still.png',
    'src/renderer/components/cat-addon/TailoredPixelCat.tsx',
    'scripts/build-cat-addon-assets.cjs'
  ]) assert.equal(existsSync(path), false, path)
})
