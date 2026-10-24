import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { appearanceStyle } from '../../src/renderer/app/appearance-style.ts'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Dark surfaces are neutral black and gray. A near-black color (no channel
// above 64) with a blue or purple cast reads as navy or violet on screen.
const tinted = (r: number, g: number, b: number): boolean => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max <= 64 && max - min >= 2 && max - min <= 16 && b >= r && b >= g
}

test('the renderer has no blue- or purple-tinted near-black colors', () => {
  const files = execSync('git ls-files src/renderer', { cwd: root, encoding: 'utf8' }).split('\n').filter((file) => /\.(css|tsx|ts)$/.test(file))
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(`${root}${file}`, 'utf8')
    for (const match of source.matchAll(/#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?![0-9a-f]{3}\b)/gi)) {
      const [r, g, b] = match.slice(1, 4).map((hex) => Number.parseInt(hex, 16))
      if (tinted(r, g, b)) offenders.push(`${file}: ${match[0]}`)
    }
    for (const match of source.matchAll(/rgba?\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})/g)) {
      const [r, g, b] = match.slice(1, 4).map(Number)
      if (tinted(r, g, b)) offenders.push(`${file}: ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the default surface tint renders neutral; a chosen tint still applies', () => {
  const neutral = appearanceStyle(DEFAULT_SETTINGS) as Record<string, string>
  assert.equal(neutral['--vast-surface-tint'], '#141414')
  const custom = structuredClone(DEFAULT_SETTINGS)
  custom.appearance.surfaceTintColor = '#2a6bff'
  assert.equal((appearanceStyle(custom) as Record<string, string>)['--vast-surface-tint'], '#2a6bff')
})
