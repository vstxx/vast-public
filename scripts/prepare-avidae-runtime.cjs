const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { spawnSync } = require('node:child_process')
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const root = join(__dirname, '..')
const sourceRoot = join(root, 'resources', 'avidae')
const cliArgs = process.argv.slice(2)
const runtimeRootArgumentIndex = cliArgs.indexOf('--runtime-root')
const runtimeRootArgument = runtimeRootArgumentIndex >= 0 ? cliArgs[runtimeRootArgumentIndex + 1] : undefined
const runtimeRoot = runtimeRootArgument ? resolve(root, runtimeRootArgument) : join(root, 'resources', 'avidae-runtime')
const buildRoot = join(root, '.vast-build', 'avidae')
const manifestPath = join(runtimeRoot, 'runtime-manifest.json')
const pythonLicenseCollector = join(__dirname, 'copy-python-runtime-licenses.py')
const ffmpegCapabilityAudit = join(__dirname, 'avidae-ffmpeg-capabilities.cjs')
const ffmpegComplianceAudit = join(__dirname, 'check-ffmpeg-release-compliance.cjs')
const ffmpegBuildRoot = join(root, '.vast-build', 'ffmpeg')
const runtimeManifestSchema = 3
const checkOnly = process.argv.includes('--check')
const resume = process.argv.includes('--resume')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (runtimeRootArgumentIndex >= 0 && !runtimeRootArgument) fail('--runtime-root requires a path.')
if (runtimeRootArgument && !checkOnly) fail('--runtime-root is supported only with --check.')
if (runtimeRootArgument && runtimeRoot !== resolve(root) && !runtimeRoot.startsWith(`${resolve(root)}${sep}`)) fail('Runtime check path must remain inside the repository.')
const runtimeReadme = `# Generated Video & Audio runtime

Public Vast packages replace this development placeholder with a generated,
integrity-manifested PyInstaller runtime, Playwright Chromium, FFmpeg and
FFprobe. Generate it with \`npm run avidae:runtime:prepare\`; verify it with
\`npm run avidae:runtime:check\`. Generated binaries are release artifacts and
are intentionally not committed.
`

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 20 * 60_000,
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(`${basename(command)} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`)
  }
  return String(result.stdout || '').trim()
}

function pythonCommand() {
  return String(process.env.VAST_AVIDAE_PYTHON || 'python').trim()
}

function auditedFfmpegPath(name, configured) {
  const expected = join(ffmpegBuildRoot, 'runtime', 'bin', `${name}.exe`)
  const requested = String(configured || expected).trim()
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  if (candidate !== resolve(expected)) fail(`${name} must come from the audited Vast FFmpeg build at ${expected}.`)
  if (!existsSync(candidate)) fail(`${name} does not exist. Run npm run ffmpeg:build first.`)
  return candidate
}

function safeResolve(base, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) fail('Runtime manifest path is invalid.')
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) fail('Runtime manifest path is unsafe.')
  const basePath = resolve(base)
  const target = resolve(basePath, ...segments)
  if (!target.startsWith(`${basePath}${sep}`)) fail('Runtime manifest path escapes the runtime root.')
  return target
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fileRecord(file) {
  const relativePath = relative(runtimeRoot, file).replace(/\\/g, '/')
  return { path: relativePath, sha256: sha256(file), size: statSync(file).size }
}

function findFiles(directory, predicate) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) return findFiles(fullPath, predicate)
    return entry.isFile() && predicate(fullPath) ? [fullPath] : []
  })
}

function isInside(base, target) {
  const relativePath = relative(resolve(base), resolve(target))
  return relativePath && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath)
}

function playwrightFullChromiumExecutables(browsersPath) {
  return findFiles(browsersPath, (file) => {
    if (basename(file).toLowerCase() !== 'chrome.exe') return false
    const relativePath = relative(browsersPath, file).replace(/\\/g, '/')
    return /^chromium-\d+\//i.test(relativePath)
  })
}

function playwrightHeadlessShellEntries(browsersPath) {
  if (!existsSync(browsersPath)) return []
  return readdirSync(browsersPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium_headless_shell-\d+$/i.test(entry.name))
    .map((entry) => join(browsersPath, entry.name))
}

function pinnedRequirement(name, requirementsFile = 'requirements.txt') {
  const source = readFileSync(join(sourceRoot, requirementsFile), 'utf8')
  const match = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}==([^\\s]+)$`, 'im').exec(source)
  if (!match) fail(`${name} must be exactly pinned in ${requirementsFile}.`)
  return match[1]
}

function installedPythonPackageVersion(python, name) {
  return run(python, ['-c', `import importlib.metadata as m; print(m.version(${JSON.stringify(name)}))`], { capture: true })
}

function verifyRuntime(executeSelfTest) {
  if (!existsSync(manifestPath)) fail('Video & Audio runtime is not prepared. Run npm run avidae:runtime:prepare.')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    fail('Video & Audio runtime manifest is invalid JSON.')
  }
  if (manifest.schemaVersion !== runtimeManifestSchema || manifest.appVersion !== pkg.version) fail('Video & Audio runtime manifest targets a different Vast version.')
  if (manifest.browser?.engine !== 'chromium' || manifest.browser?.distribution !== 'playwright-chromium' || manifest.browser?.headlessMode !== 'new') {
    fail('Video & Audio runtime browser policy is invalid.')
  }
  const records = ['executable', 'ffmpeg', 'ffprobe', 'ffmpegProvenance', 'ffmpegCapabilities']
  const files = {}
  for (const name of records) {
    const record = manifest[name]
    if (!record || !/^[a-f0-9]{64}$/.test(String(record.sha256 || ''))) fail(`Runtime ${name} record is invalid.`)
    const file = safeResolve(runtimeRoot, record.path)
    if (!existsSync(file) || !statSync(file).isFile()) fail(`Runtime ${name} is missing.`)
    if (sha256(file) !== record.sha256) fail(`Runtime ${name} failed SHA-256 verification.`)
    if (statSync(file).size !== record.size) fail(`Runtime ${name} size does not match its manifest.`)
    files[name] = file
  }
  if (!manifest.ffmpegSourceBundle || manifest.ffmpegSourceBundle.fileName !== 'ffmpeg-corresponding-source-win64.tar.zst' ||
      !/^[a-f0-9]{64}$/.test(String(manifest.ffmpegSourceBundle.sha256 || '')) ||
      !Number.isSafeInteger(manifest.ffmpegSourceBundle.size) || manifest.ffmpegSourceBundle.size < 1) {
    fail('Runtime FFmpeg corresponding-source metadata is invalid.')
  }
  let ffmpegProvenance
  try { ffmpegProvenance = JSON.parse(readFileSync(files.ffmpegProvenance, 'utf8')) } catch { fail('Runtime FFmpeg provenance is invalid JSON.') }
  if (ffmpegProvenance.licenseMode !== 'gpl-3.0-or-later' ||
      ffmpegProvenance.ffmpeg?.sha256 !== manifest.ffmpeg.sha256 ||
      ffmpegProvenance.ffprobe?.sha256 !== manifest.ffprobe.sha256 ||
      ffmpegProvenance.capabilityReport?.sha256 !== manifest.ffmpegCapabilities.sha256 ||
      ffmpegProvenance.sourceBundle?.sha256 !== manifest.ffmpegSourceBundle.sha256 ||
      ffmpegProvenance.sourceBundle?.size !== manifest.ffmpegSourceBundle.size) {
    fail('Runtime FFmpeg provenance does not match the bundled binaries and corresponding-source record.')
  }
  const browserRecord = manifest.browser.executable
  if (!browserRecord || !/^[a-f0-9]{64}$/.test(String(browserRecord.sha256 || ''))) fail('Runtime Chromium record is invalid.')
  const chromium = safeResolve(runtimeRoot, browserRecord.path)
  if (!existsSync(chromium) || !statSync(chromium).isFile()) fail('Runtime Chromium is missing.')
  if (sha256(chromium) !== browserRecord.sha256 || statSync(chromium).size !== browserRecord.size) fail('Runtime Chromium failed SHA-256 verification.')
  files.chromium = chromium
  if (!Array.isArray(manifest.licenseFiles) || manifest.licenseFiles.length === 0) {
    fail('Video & Audio runtime manifest has no third-party license inventory.')
  }
  for (const record of manifest.licenseFiles) {
    if (!record || !/^[a-f0-9]{64}$/.test(String(record.sha256 || ''))) fail('Runtime license record is invalid.')
    const file = safeResolve(runtimeRoot, record.path)
    if (!existsSync(file) || !statSync(file).isFile()) fail(`Runtime license file is missing: ${record.path}`)
    if (sha256(file) !== record.sha256 || statSync(file).size !== record.size) fail(`Runtime license file failed integrity verification: ${record.path}`)
  }
  const licensePaths = manifest.licenseFiles.map((record) => String(record.path || '').toLowerCase())
  for (const required of ['ffmpeg-gplv3', 'ffmpeg-readme', 'x264-copying', 'playwright-license', 'chromium-license', 'python-packages.json']) {
    if (!licensePaths.some((path) => path.includes(required))) fail(`Runtime license inventory is missing ${required}.`)
  }
  const browsersPath = safeResolve(runtimeRoot, manifest.playwrightBrowsersPath)
  if (!existsSync(browsersPath)) fail('Playwright browsers directory is missing.')
  if (!isInside(browsersPath, files.chromium)) fail('Runtime Chromium is outside the verified Playwright browser directory.')
  if (playwrightHeadlessShellEntries(browsersPath).length > 0 || findFiles(browsersPath, (file) => basename(file).toLowerCase() === 'chrome-headless-shell.exe').length > 0) {
    fail('Redundant Playwright headless shell is present in the production runtime.')
  }

  let selfTest = null
  if (executeSelfTest) {
    const selfTestOutput = run(files.executable, ['--runtime-self-test'], {
      capture: true,
      timeout: 60_000,
      env: {
        ...process.env,
        FFMPEG_PATH: files.ffmpeg,
        FFPROBE_PATH: files.ffprobe,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        VAST_AVIDAE_CHROMIUM_PATH: files.chromium,
        VAST_AVIDAE_BUNDLED_RUNTIME: '1'
      }
    })
    try {
      selfTest = JSON.parse(selfTestOutput)
    } catch {
      fail('Video & Audio executable returned an invalid self-test result.')
    }
    if (selfTest?.ok !== true || selfTest?.headless !== 'new' || selfTest?.videoRecording !== true) {
      fail('Video & Audio executable did not pass its complete browser/media self-test.')
    }
    run(files.ffmpeg, ['-version'], { capture: true, timeout: 30_000 })
    run(files.ffprobe, ['-version'], { capture: true, timeout: 30_000 })
  }
  console.log(JSON.stringify({ ok: true, runtimeRoot, runtimeVersion: manifest.runtimeVersion, files: [...records, 'chromium'], browser: manifest.browser, selfTest }, null, 2))
}

function prepareRuntime() {
  if (process.platform !== 'win32') fail('The current public Vast package target requires preparing the Video & Audio runtime on Windows.')
  const python = pythonCommand()
  const expectedPlaywright = pinnedRequirement('playwright')
  const expectedPyInstaller = pinnedRequirement('PyInstaller', 'requirements-build.txt')
  const actualPlaywright = installedPythonPackageVersion(python, 'playwright')
  const actualPyInstaller = installedPythonPackageVersion(python, 'PyInstaller')
  if (actualPlaywright !== expectedPlaywright || actualPyInstaller !== expectedPyInstaller) {
    fail('Python build dependencies do not match their pins. Run python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt.')
  }

  const ffmpegSource = auditedFfmpegPath('ffmpeg', process.env.VAST_AVIDAE_FFMPEG)
  const ffprobeSource = auditedFfmpegPath('ffprobe', process.env.VAST_AVIDAE_FFPROBE)
  run(process.execPath, [ffmpegComplianceAudit, '--root', ffmpegBuildRoot], { timeout: 10 * 60_000 })
  const approvedRuntimeRoot = resolve(root, 'resources', 'avidae-runtime')
  const approvedBuildRoot = resolve(root, '.vast-build', 'avidae')
  if (resolve(runtimeRoot) !== approvedRuntimeRoot || resolve(buildRoot) !== approvedBuildRoot) fail('Generated runtime paths are not the approved workspace paths.')
  const browsersPath = join(runtimeRoot, 'ms-playwright')
  const browserLicenseTarget = join(runtimeRoot, 'licenses', 'Chromium-LICENSE.txt')
  let browserLicenseSource = existsSync(browserLicenseTarget) ? browserLicenseTarget : undefined
  if (!resume) {
    rmSync(runtimeRoot, { recursive: true, force: true })
    rmSync(buildRoot, { recursive: true, force: true })
    mkdirSync(runtimeRoot, { recursive: true })
    mkdirSync(buildRoot, { recursive: true })
    writeFileSync(join(runtimeRoot, 'README.md'), runtimeReadme, 'utf8')

    const dataSeparator = process.platform === 'win32' ? ';' : ':'
    console.log('Building the bundled Video & Audio service...')
    run(python, [
      '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--noupx',
      '--name', 'VastVideoAudio',
      '--distpath', runtimeRoot,
      '--workpath', join(buildRoot, 'work'),
      '--specpath', buildRoot,
      '--paths', sourceRoot,
      '--add-data', `${join(sourceRoot, 'templates')}${dataSeparator}templates`,
      '--add-data', `${join(sourceRoot, 'static')}${dataSeparator}static`,
      '--copy-metadata', 'playwright',
      '--collect-all', 'yt_dlp',
      '--hidden-import', 'engineio.async_drivers.threading',
      join(sourceRoot, 'app.py')
    ])

    console.log('Installing only the pinned full Playwright Chromium runtime...')
    run(python, ['-m', 'playwright', 'install', '--no-shell', 'chromium'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
    })
    const licenseBrowserPath = join(buildRoot, 'playwright-license-browser')
    rmSync(licenseBrowserPath, { recursive: true, force: true })
    console.log('Staging the matching Chromium notice inventory outside the shipped runtime...')
    run(python, ['-m', 'playwright', 'install', '--only-shell', 'chromium'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: licenseBrowserPath }
    })
    browserLicenseSource = findFiles(licenseBrowserPath, (file) => basename(file).toLowerCase() === 'license.headless_shell')[0]
    if (!browserLicenseSource) fail('The pinned Playwright Chromium distribution does not expose its required license inventory.')
  } else {
    console.log('Resuming from the existing generated service and Chromium runtime...')
    if (!existsSync(join(runtimeRoot, 'VastVideoAudio', 'VastVideoAudio.exe'))) fail('Cannot resume: the generated Video & Audio executable is missing.')
    if (!findFiles(browsersPath, (file) => basename(file).toUpperCase() === 'INSTALLATION_COMPLETE').length) {
      fail('Cannot resume: the Playwright browser installation is incomplete.')
    }
    browserLicenseSource = browserLicenseSource || findFiles(browsersPath, (file) => basename(file).toLowerCase() === 'license.headless_shell')[0]
  }

  const mediaRoot = join(runtimeRoot, 'media')
  const licensesRoot = join(runtimeRoot, 'licenses')
  mkdirSync(mediaRoot, { recursive: true })
  mkdirSync(licensesRoot, { recursive: true })
  if (!browserLicenseSource || !existsSync(browserLicenseSource)) fail('The Chromium license inventory is unavailable.')
  if (resolve(browserLicenseSource) !== resolve(browserLicenseTarget)) copyFileSync(browserLicenseSource, browserLicenseTarget)
  for (const redundantShell of playwrightHeadlessShellEntries(browsersPath)) {
    if (!isInside(browsersPath, redundantShell)) fail('Refusing to prune a Playwright path outside the browser root.')
    rmSync(redundantShell, { recursive: true, force: true })
  }
  const ffmpegTarget = join(mediaRoot, 'ffmpeg.exe')
  const ffprobeTarget = join(mediaRoot, 'ffprobe.exe')
  copyFileSync(ffmpegSource, ffmpegTarget)
  copyFileSync(ffprobeSource, ffprobeTarget)
  const ffmpegDistributionRoot = dirname(dirname(ffmpegSource))
  const ffmpegReadme = join(ffmpegDistributionRoot, 'README.txt')
  const ffmpegProvenanceSource = join(ffmpegDistributionRoot, 'ffmpeg-build-provenance.json')
  const ffmpegCapabilitiesSource = join(ffmpegBuildRoot, 'avidae-ffmpeg-capabilities.json')
  const ffmpegSourceBundle = join(ffmpegBuildRoot, 'ffmpeg-corresponding-source-win64.tar.zst')
  if (!existsSync(ffmpegReadme) || !existsSync(ffmpegProvenanceSource) || !existsSync(ffmpegCapabilitiesSource) || !existsSync(ffmpegSourceBundle)) {
    fail('Audited FFmpeg README, provenance, capability report, or corresponding-source archive is missing.')
  }
  for (const license of findFiles(join(ffmpegDistributionRoot, 'licenses'), () => true)) {
    copyFileSync(license, join(licensesRoot, basename(license)))
  }
  copyFileSync(ffmpegReadme, join(licensesRoot, 'FFmpeg-README.txt'))
  const ffmpegProvenanceTarget = join(runtimeRoot, 'ffmpeg-build-provenance.json')
  const ffmpegCapabilitiesTarget = join(runtimeRoot, 'avidae-ffmpeg-capabilities.json')
  copyFileSync(ffmpegProvenanceSource, ffmpegProvenanceTarget)
  copyFileSync(ffmpegCapabilitiesSource, ffmpegCapabilitiesTarget)
  copyFileSync(join(sourceRoot, 'THIRD_PARTY_RUNTIME.md'), join(runtimeRoot, 'THIRD_PARTY_RUNTIME.md'))
  console.log('Verifying the complete Video & Audio FFmpeg capability contract...')
  run(process.execPath, [ffmpegCapabilityAudit, '--ffmpeg', ffmpegTarget, '--ffprobe', ffprobeTarget], { timeout: 5 * 60_000 })

  rmSync(join(licensesRoot, 'python'), { recursive: true, force: true })
  run(python, [
    pythonLicenseCollector,
    join(licensesRoot, 'python'),
    'Flask', 'Flask-SocketIO', 'playwright', 'Pillow', 'python-dotenv',
    'simple-websocket', 'yt-dlp'
  ], { capture: true })

  const playwrightLicense = run(python, ['-c', "import importlib.metadata as m; d=m.distribution('playwright'); files=[f for f in (d.files or []) if str(f).lower().replace('\\\\','/').endswith(('/licenses/license','dist-info/license'))]; print(str(d.locate_file(files[0])) if files else '')"], { capture: true })
  if (!playwrightLicense || !existsSync(playwrightLicense)) fail('The installed Playwright distribution does not expose its required license file.')
  copyFileSync(playwrightLicense, join(licensesRoot, 'Playwright-LICENSE.txt'))

  const executable = join(runtimeRoot, 'VastVideoAudio', 'VastVideoAudio.exe')
  const chromiumExecutables = playwrightFullChromiumExecutables(browsersPath)
  if (!existsSync(executable) || chromiumExecutables.length !== 1) fail('Generated runtime must contain exactly one full Playwright Chromium executable.')
  const chromium = chromiumExecutables[0]
  if (playwrightHeadlessShellEntries(browsersPath).length > 0 || findFiles(browsersPath, (file) => basename(file).toLowerCase() === 'chrome-headless-shell.exe').length > 0) {
    fail('Generated runtime still contains a redundant Playwright headless shell.')
  }
  const ffmpegVersion = run(ffmpegTarget, ['-version'], { capture: true }).split(/\r?\n/)[0]
  const licenseFiles = findFiles(runtimeRoot, (file) => {
    const name = basename(file)
    return /(?:license|licence|copying|notice|gpl|lgpl)/i.test(name) || name === 'FFmpeg-README.txt' || name === 'python-packages.json' || name === 'THIRD_PARTY_RUNTIME.md'
  }).map(fileRecord)
  const manifest = {
    schemaVersion: runtimeManifestSchema,
    appVersion: pkg.version,
    runtimeVersion: `${pkg.version}-python-${run(python, ['--version'], { capture: true }).replace(/^Python\s+/i, '')}`,
    createdAt: new Date().toISOString(),
    python: run(python, ['--version'], { capture: true }),
    playwright: actualPlaywright,
    pyinstaller: actualPyInstaller,
    ffmpegVersion,
    executable: fileRecord(executable),
    ffmpeg: fileRecord(ffmpegTarget),
    ffprobe: fileRecord(ffprobeTarget),
    ffmpegProvenance: fileRecord(ffmpegProvenanceTarget),
    ffmpegCapabilities: fileRecord(ffmpegCapabilitiesTarget),
    ffmpegSourceBundle: {
      fileName: basename(ffmpegSourceBundle),
      sha256: sha256(ffmpegSourceBundle),
      size: statSync(ffmpegSourceBundle).size
    },
    browser: {
      engine: 'chromium',
      distribution: 'playwright-chromium',
      headlessMode: 'new',
      executable: fileRecord(chromium)
    },
    playwrightBrowsersPath: relative(runtimeRoot, browsersPath).replace(/\\/g, '/'),
    licenseFiles
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log('Runtime manifest written; running executable and integrity self-tests...')
  verifyRuntime(true)
}

try {
  if (checkOnly) verifyRuntime(true)
  else prepareRuntime()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
