import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const patchPath = 'patches/electron-chrome-extensions-4.9.0-vast.patch'
const preparePath = 'scripts/prepare-extension-compat-runtime.cjs'
const preloadPath = 'node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js'
const cjsRuntimePath = 'node_modules/electron-chrome-extensions/dist/cjs/index.js'
const esmRuntimePath = 'node_modules/electron-chrome-extensions/dist/esm/index.mjs'
const sourcePatchPath = 'experiments/electron-chrome-extensions-4.9.0/0001-vast-browser-compatibility.patch'

test('approved ECE preload never logs extension API arguments or results', async () => {
  const preload = await readFile(preloadPath, 'utf8')

  assert.doesNotMatch(preload, /console\.log\(fnName,\s*args\)/)
  assert.doesNotMatch(preload, /console\.log\(fnName,\s*"\(result\)"/)
  assert.doesNotMatch(preload, /console\.log\(name,\s*"\(result\)",\s*\.\.\.args\)/)
  assert.doesNotMatch(preload, /console\.error\((?:e|error)\)/)
  assert.match(preload, /console\.error\("Extension API request failed\."\)/)
  assert.match(preload, /\[VastCompat\] Receiving end does not exist method=\$\{fnName\}/)
})

test('ECE preload recognizes extension subframes by runtime identity before their final URL is visible', async () => {
  const preload = await readFile(preloadPath, 'utf8')

  assert.match(preload, /process\.type === "service-worker" \|\| globalThis\.chrome\?\.runtime\?\.id \|\| location\.href\.startsWith\("chrome-extension:\/\/"\)/)
  assert.doesNotMatch(preload, /const extensionId = chrome\.runtime\?\.id;\s+if \(!extensionId\)/)
})

test('tracked ECE patch exposes Chrome privacy settings only for the three approved service keys', async () => {
  const patch = await readFile(patchPath, 'utf8')

  for (const key of [
    'services.passwordSavingEnabled',
    'services.autofillAddressEnabled',
    'services.autofillCreditCardEnabled'
  ]) {
    assert.match(patch, new RegExp(key.replaceAll('.', '\\.')))
  }
  assert.match(patch, /privacy\.get/)
  assert.match(patch, /privacy\.set/)
  assert.match(patch, /privacy\.clear/)
  assert.deepEqual(
    [...new Set([...patch.matchAll(/new ChromeSetting\("([^"]+)"\)/g)].map((match) => match[1]))].sort(),
    [
      'services.autofillAddressEnabled',
      'services.autofillCreditCardEnabled',
      'services.passwordSavingEnabled'
    ].sort()
  )
  assert.match(patch, /PRIVACY_SERVICE_KEYS/)
  assert.match(patch, /privacy\.onChange:\$\{(?:key|request\.key)\}/)
  assert.match(patch, /rejectErrors: true/)
  assert.match(patch, /finally \{[\s\S]*?delete runtime\.lastError;/)
  assert.doesNotMatch(patch, /webRTCIPHandlingPolicy[^\n]*privacy\.(?:get|set|clear)/)
  assert.doesNotMatch(patch, /networkPredictionEnabled[^\n]*privacy\.(?:get|set|clear)/)
})

test('action.openPopup resolves its sender tab and rejects unavailable popup contexts', async () => {
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /event\.type === "frame" \? this\.ctx\.store\.getTabById\(event\.sender\.id\)/)
  assert.match(patch, /senderWindow \?\? this\.ctx\.store\.getCurrentWindow\(\)/)
  assert.match(patch, /throw new Error\("No active tab is available for action popup\."\)/)
  assert.match(patch, /if \(!toggle\)[\s\S]*?throw new Error\("No popup is available for action\."\)/)
  assert.match(patch, /return this\.activateClick\(/)

  for (const runtimePath of [cjsRuntimePath, esmRuntimePath]) {
    const runtime = await readFile(runtimePath, 'utf8')
    assert.match(runtime, /event\.type === "frame" \? this\.ctx\.store\.getTabById\(event\.sender\.id\)/)
    assert.match(runtime, /senderWindow \?\? this\.ctx\.store\.getCurrentWindow\(\)/)
    assert.match(runtime, /throw new Error\("No active tab is available for action popup\."\)/)
    assert.match(runtime, /if \(!toggle\)[\s\S]*?throw new Error\("No popup is available for action\."\)/)
  }
})

test('action popup behavior matches Chromium for API opens, popup URLs, and preloaded extensions', async () => {
  const expected = [
    /if \(this\.hidden\)[\s\S]*?preventing close before popup is shown/,
    /await this\.ctx\.store\.openPopup\(event\.extension, activeTab, window\)/,
    /propName === ["']popup["'][\s\S]*?getExtensionUrl\(extension, result\)/,
    /sessionExtensions\.getAllExtensions\(\)\.forEach\(\(extension\) => this\.processExtension\(extension\)\)/,
    /return this\.activateClick\([\s\S]*?, false\)/,
    /activateClick\(details[^)]*, toggle = true\)/,
    /if \(sameExtension && !toggle\) return/
  ]

  for (const path of [patchPath, sourcePatchPath, cjsRuntimePath, esmRuntimePath]) {
    const source = await readFile(path, 'utf8')
    for (const pattern of expected) assert.match(source, pattern)
  }
})

test('programmatic action popups can be delegated to the embedding browser UI', async () => {
  const expected = [
    /openPopup\?\(/,
    /typeof this\.impl\.openPopup !== ["']function["']/,
    /this\.impl\.openPopup\(extension, tab, window\)/
  ]
  for (const path of [patchPath, sourcePatchPath, cjsRuntimePath, esmRuntimePath]) {
    const source = await readFile(path, 'utf8')
    for (const pattern of expected.slice(path.includes('patch') ? 0 : 1)) assert.match(source, pattern)
  }
})

test('action state lazily restores manifest defaults when extension-loaded was missed', async () => {
  const expected = [
    /const sessionExtensions = this\.ctx\.session\.extensions \|\| this\.ctx\.session/,
    /const extension = sessionExtensions\.getExtension\(extensionId\)/,
    /const defaults = extension \? getBrowserActionDefaults\(extension\)/,
    /if \(defaults\) Object\.assign\(action, defaults\)/
  ]

  for (const path of [patchPath, sourcePatchPath, cjsRuntimePath, esmRuntimePath]) {
    const source = await readFile(path, 'utf8')
    for (const pattern of expected) assert.match(source, pattern)
  }
})

test('tracked ECE patch changes only audited distribution files', async () => {
  const patch = await readFile(patchPath, 'utf8')
  const changed = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => {
    assert.equal(match[1], match[2])
    return match[1]
  })

  assert.deepEqual(changed.sort(), [
    'dist/chrome-extension-api.preload.js',
    'dist/cjs/index.js',
    'dist/esm/index.mjs',
    'dist/types/browser/impl.d.ts'
  ].sort())
})

test('runtime preparation is patch-and-fingerprint based rather than source string replacement', async () => {
  const source = await readFile(preparePath, 'utf8')

  assert.match(source, /electron-chrome-extensions-4\.9\.0-vast\.patch/)
  assert.match(source, /sha256/i)
  assert.match(source, /spawnSync\('git',[\s\S]*?'apply'/)
  assert.doesNotMatch(source, /source\.replace\(/)
  assert.doesNotMatch(source, /writeFileSync\([^)]*source/)
})

test('the pinned patch applies once, verifies the exact result, and refuses to stack', async () => {
  const root = resolve('.')
  const temporary = await mkdtemp(join(tmpdir(), 'vast-ece-patch-'))
  const packageRoot = join(temporary, 'electron-chrome-extensions')
  const absolutePatch = join(root, patchPath)
  const prepare = join(root, preparePath)
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })

  try {
    await cp(join(root, 'node_modules', 'electron-chrome-extensions'), packageRoot, { recursive: true })
    const reverseCheck = run('git', ['-C', packageRoot, 'apply', '--reverse', '--check', absolutePatch])
    if (reverseCheck.status === 0) {
      assert.equal(run('git', ['-C', packageRoot, 'apply', '--reverse', absolutePatch]).status, 0)
    } else {
      assert.equal(run('git', ['-C', packageRoot, 'apply', '--check', absolutePatch]).status, 0)
    }

    const missing = run(process.execPath, [prepare, '--check', '--root', packageRoot])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /approved patch is not applied/)

    const applied = run(process.execPath, [prepare, '--root', packageRoot])
    assert.equal(applied.status, 0, applied.stderr)
    const checked = run(process.execPath, [prepare, '--check', '--root', packageRoot])
    assert.equal(checked.status, 0, checked.stderr)
    const report = JSON.parse(checked.stdout.trim().split(/\r?\n/).at(-1)!) as Record<string, unknown>
    assert.equal(report.eceVersion, '4.9.0')
    assert.match(String(report.patchSha256), /^[a-f0-9]{64}$/)
    assert.match(String(report.runtimeSha256), /^[a-f0-9]{64}$/)

    const stacked = run(process.execPath, [prepare, '--root', packageRoot])
    assert.notEqual(stacked.status, 0)
    assert.match(stacked.stderr, /already applied; refusing to stack/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
