import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rendererRoot = new URL('../../src/renderer/', import.meta.url)

function collectTsx(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? collectTsx(path) : entry.endsWith('.tsx') ? [path] : []
  })
}

test('legacy button class systems stay removed from the renderer', () => {
  const files = collectTsx(fileURLToPath(rendererRoot))
  const legacyClasses = [
    'settings-action',
    'browser-tools-action',
    'smart-unload-action',
    'link-preview-action',
    'extensions-toolbar-primary-action',
    'extensions-toolbar-secondary-action'
  ]
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const legacy of legacyClasses) {
      if (source.includes(`${legacy} `) || source.includes(`${legacy}"`) || source.includes(`${legacy}'`) || source.includes(`${legacy}\``)) {
        offenders.push(`${file}: ${legacy}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'Ordinary buttons must use the shared vast-button / vast-icon-button / vast-menu-item system')
})

test('ordinary button CTA recipes are not recreated with raw Tailwind strings', () => {
  const files = collectTsx(fileURLToPath(rendererRoot))
  // Full legacy recipe fragments that indicate a hand-rolled ordinary button
  // instead of the shared control system. Kept intentionally short and exact.
  const recipes = [
    /className="[^"]*bg-vast-cyan px-\d[^"]*text-sm font-semibold text-black/,
    /className="[^"]*rounded-control border border-white\/10 bg-white\/\[0\.04[^\"]*px-4 py-2 text-sm font-medium/,
    /className="grid h-\d+ w-\d+ place-items-center rounded-control text-vast-soft hover:bg-white\/10 hover:text-white"/
  ]
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const recipe of recipes) {
      const match = source.match(recipe)
      if (match) offenders.push(`${file}: ${match[0].slice(0, 80)}`)
    }
  }
  assert.deepEqual(offenders, [], 'Use VastButton / IconButton variants instead of recreating button recipes')
})
