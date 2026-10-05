#!/usr/bin/env node
// Audit GN's generated Blink compile flags, not just the hand-written args.gn.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const option = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const separator = arg.indexOf('=')
  return separator < 0 ? [arg.slice(2), true] : [arg.slice(2, separator), arg.slice(separator + 1)]
}))
if (!option['build-dir'] || !path.isAbsolute(option['build-dir'])) {
  throw new Error('Usage: node scripts/verify-electron-release-profile.cjs --build-dir=<absolute GN output> [--require-binary]')
}
const buildDir = path.resolve(option['build-dir'])
const read = (relative) => fs.readFileSync(path.join(buildDir, relative), 'utf8')
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const requireFact = (condition, message) => { if (!condition) throw new Error(message) }

const sourceArgs = read('args.gn')
const generatedArgs = read('vast-gn-args-audit.txt')
const coreNinja = read(path.join('obj', 'third_party', 'blink', 'renderer', 'core', 'core.ninja'))
const defines = coreNinja.slice(0, coreNinja.indexOf('\n'))
const valueOf = (name) => new RegExp(`^${name} = (.+)$`, 'm').exec(generatedArgs)?.[1]?.trim()

requireFact(sourceArgs.includes('import("//electron/build/args/release.gn")'), 'GN source args do not import release.gn')
requireFact(!sourceArgs.includes('testing.gn'), 'GN source args import testing.gn')
for (const [name, expected] of Object.entries({
  is_debug: 'false', is_official_build: 'true', dcheck_always_on: 'false',
  chrome_pgo_phase: '2', use_thin_lto: 'true',
  partition_alloc_dcheck_always_on: 'false', v8_dcheck_always_on: 'false'
})) requireFact(valueOf(name) === expected, `GN ${name}: expected ${expected}, got ${valueOf(name) || '(missing)'}`)
requireFact(valueOf('v8_builtins_profiling_log_file')?.includes('electron-v8-builtins.profile'), 'V8 builtins profile is missing')
requireFact(defines.includes('-DOFFICIAL_BUILD') && defines.includes('-DNDEBUG'), 'Blink core lacks official NDEBUG defines')
requireFact(!defines.includes('-DDCHECK_ALWAYS_ON'), 'Blink core still enables DCHECK_ALWAYS_ON')
requireFact(coreNinja.includes('-fprofile-use=') && coreNinja.includes('-flto=thin'), 'Blink core lacks PGO or ThinLTO flags')
requireFact(coreNinja.includes('nth_index_cache.obj: cxx'), 'Blink nth-index-cache compile target is missing')

const executable = path.join(buildDir, 'electron.exe')
if (option['require-binary']) requireFact(fs.existsSync(executable), 'Release-profile electron.exe has not been built')
const report = {
  buildDir,
  flagsVerified: true,
  sourceArgsSha256: hash(path.join(buildDir, 'args.gn')),
  generatedArgsSha256: hash(path.join(buildDir, 'vast-gn-args-audit.txt')),
  executable: fs.existsSync(executable) ? { size: fs.statSync(executable).size, sha256: hash(executable) } : null
}
console.log(JSON.stringify(report, null, 2))
