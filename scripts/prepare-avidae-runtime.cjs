const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const root = join(__dirname, '..')
const sourceRoot = join(root, 'resources', 'avidae')
const runtimeRoot = join(root, 'resources', 'avidae-runtime')
const buildRoot = join(root, '.vast-build', 'avidae')
const manifestPath = join(runtimeRoot, 'runtime-manifest.json')
const pythonLicenseCollector = join(__dirname, 'copy-python-runtime-licenses.py')
const checkOnly = process.argv.includes('--check')
const resume = process.argv.includes('--resume')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
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

function commandPath(name, configured) {
  const requested = String(configured || '').trim()
  if (requested) {
    const candidate = isAbsolute(requested) ? requested : resolve(root, requested)
    if (!existsSync(candidate)) fail(`${name} does not exist: ${candidate}`)
    return candidate
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const output = run(locator, [name], { capture: true })
  const candidate = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line && existsSync(line))
  if (!candidate) fail(`${name} was not found. Set VAST_AVIDAE_${name.toUpperCase()} to a trusted binary.`)
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
  if (manifest.schemaVersion !== 1 || manifest.appVersion !== pkg.version) fail('Video & Audio runtime manifest targets a different Vast version.')
  const records = ['executable', 'ffmpeg', 'ffprobe', 'chromium']
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
  for (const required of ['ffmpeg-license', 'ffmpeg-readme', 'playwright-license', 'license.headless_shell', 'python-packages.json']) {
    if (!licensePaths.some((path) => path.includes(required))) fail(`Runtime license inventory is missing ${required}.`)
  }
  const browsersPath = safeResolve(runtimeRoot, manifest.playwrightBrowsersPath)
  if (!existsSync(browsersPath)) fail('Playwright browsers directory is missing.')

  if (executeSelfTest) {
    run(files.executable, ['--runtime-self-test'], {
      capture: true,
      timeout: 60_000,
      env: {
        ...process.env,
        FFMPEG_PATH: files.ffmpeg,
        FFPROBE_PATH: files.ffprobe,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath
      }
    })
    run(files.ffmpeg, ['-version'], { capture: true, timeout: 30_000 })
    run(files.ffprobe, ['-version'], { capture: true, timeout: 30_000 })
    const chromiumProfile = mkdtempSync(join(tmpdir(), 'vast-avidae-chromium-'))
    try {
      const chromiumOutput = run(files.chromium, [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--no-first-run',
        `--user-data-dir=${chromiumProfile}`,
        '--dump-dom',
        'data:text/html,<title>vast-runtime-ok</title>'
      ], { capture: true, timeout: 30_000 })
      if (!chromiumOutput.includes('vast-runtime-ok')) fail('Bundled Chromium did not complete its headless self-test.')
    } finally {
      rmSync(chromiumProfile, { recursive: true, force: true })
    }
  }
  console.log(JSON.stringify({ ok: true, runtimeRoot, runtimeVersion: manifest.runtimeVersion, files: records }, null, 2))
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

  const ffmpegSource = commandPath('ffmpeg', process.env.VAST_AVIDAE_FFMPEG)
  const ffprobeSource = commandPath('ffprobe', process.env.VAST_AVIDAE_FFPROBE)
  const approvedRuntimeRoot = resolve(root, 'resources', 'avidae-runtime')
  const approvedBuildRoot = resolve(root, '.vast-build', 'avidae')
  if (resolve(runtimeRoot) !== approvedRuntimeRoot || resolve(buildRoot) !== approvedBuildRoot) fail('Generated runtime paths are not the approved workspace paths.')
  const browsersPath = join(runtimeRoot, 'ms-playwright')
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
      '--collect-all', 'playwright',
      '--collect-all', 'yt_dlp',
      '--hidden-import', 'engineio.async_drivers.threading',
      join(sourceRoot, 'app.py')
    ])

    console.log('Installing the pinned Playwright Chromium runtime...')
    run(python, ['-m', 'playwright', 'install', 'chromium'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
    })
  } else {
    console.log('Resuming from the existing generated service and Chromium runtime...')
    if (!existsSync(join(runtimeRoot, 'VastVideoAudio', 'VastVideoAudio.exe'))) fail('Cannot resume: the generated Video & Audio executable is missing.')
    if (!findFiles(browsersPath, (file) => basename(file).toUpperCase() === 'INSTALLATION_COMPLETE').length) {
      fail('Cannot resume: the Playwright browser installation is incomplete.')
    }
  }

  const mediaRoot = join(runtimeRoot, 'media')
  const licensesRoot = join(runtimeRoot, 'licenses')
  mkdirSync(mediaRoot, { recursive: true })
  mkdirSync(licensesRoot, { recursive: true })
  const ffmpegTarget = join(mediaRoot, 'ffmpeg.exe')
  const ffprobeTarget = join(mediaRoot, 'ffprobe.exe')
  copyFileSync(ffmpegSource, ffmpegTarget)
  copyFileSync(ffprobeSource, ffprobeTarget)
  const ffmpegDistributionRoot = dirname(dirname(ffmpegSource))
  const ffmpegLicense = join(ffmpegDistributionRoot, 'LICENSE')
  const ffmpegReadme = join(ffmpegDistributionRoot, 'README.txt')
  if (!existsSync(ffmpegLicense) || !existsSync(ffmpegReadme)) {
    fail('FFmpeg distribution must include its LICENSE and README.txt with exact source-build information.')
  }
  copyFileSync(ffmpegLicense, join(licensesRoot, 'FFmpeg-LICENSE.txt'))
  copyFileSync(ffmpegReadme, join(licensesRoot, 'FFmpeg-README.txt'))
  copyFileSync(join(sourceRoot, 'THIRD_PARTY_RUNTIME.md'), join(runtimeRoot, 'THIRD_PARTY_RUNTIME.md'))

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

  const browserLicenses = findFiles(browsersPath, (file) => /(?:license|licence|copying|notice)/i.test(basename(file)))
  if (!browserLicenses.some((file) => basename(file).toLowerCase() === 'license.headless_shell')) {
    fail('The installed Playwright Chromium runtime does not expose LICENSE.headless_shell.')
  }

  const executable = join(runtimeRoot, 'VastVideoAudio', 'VastVideoAudio.exe')
  const chromium = findFiles(browsersPath, (file) => basename(file).toLowerCase() === 'chrome-headless-shell.exe')[0]
  if (!existsSync(executable) || !chromium) fail('Generated runtime is missing its executable or Playwright Chromium.')
  const ffmpegVersion = run(ffmpegTarget, ['-version'], { capture: true }).split(/\r?\n/)[0]
  const licenseFiles = findFiles(runtimeRoot, (file) => {
    const name = basename(file)
    return /(?:license|licence|copying|notice)/i.test(name) || name === 'FFmpeg-README.txt' || name === 'python-packages.json' || name === 'THIRD_PARTY_RUNTIME.md'
  }).map(fileRecord)
  const manifest = {
    schemaVersion: 1,
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
    chromium: fileRecord(chromium),
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
