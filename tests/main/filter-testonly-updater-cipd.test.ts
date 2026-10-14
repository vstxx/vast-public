import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../experiments/electron-44-patches/filter-testonly-updater-cipd.cjs', import.meta.url))

test('retains every non-updater CIPD entry and removes exactly twelve test fixtures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vast-cipd-filter-'))
  const input = join(dir, 'input.ensure')
  const output = join(dir, 'output.ensure')
  const entries: string[] = ['$ParanoidMode CheckPresence']
  for (const product of ['chrome', 'chromium']) {
    for (const arch of ['arm64', 'x86', 'x86_64']) {
      for (const suffix of ['', '_sans_iid']) {
        entries.push(`@Subdir src/third_party/updater/${product}_win_${arch}${suffix}/cipd`)
        entries.push(`chromium/third_party/updater/${product}_win_${arch} deadbeef`)
      }
    }
  }
  for (let index = 0; index < 26; index++) {
    entries.push(`@Subdir src/third_party/needed-${index}`)
    entries.push(`chromium/third_party/needed-${index} abcdef`)
  }
  writeFileSync(input, `${entries.join('\n')}\n`)
  const stdout = execFileSync(process.execPath, [script, input, output], { encoding: 'utf8' })
  const filtered = readFileSync(output, 'utf8')
  assert.match(stdout, /Removed 12 test-only updater packages; retained 26 CIPD entries/)
  assert.match(filtered, /\$ParanoidMode CheckPresence/)
  assert.equal((filtered.match(/@Subdir /g) || []).length, 26)
  assert.doesNotMatch(filtered, /@Subdir src\/third_party\/updater\//)
  assert.match(filtered, /chromium\/third_party\/needed-25 abcdef/)
})

test('fails closed for a changed updater package identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vast-cipd-filter-'))
  const input = join(dir, 'input.ensure')
  const output = join(dir, 'output.ensure')
  writeFileSync(input, '@Subdir src/third_party/updater/chrome_win_x86/cipd\nchromium/third_party/updater/unexpected deadbeef\n')
  const run = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /Unexpected package/)
})
