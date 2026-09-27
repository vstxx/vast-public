const fs = require('node:fs')
const path = require('node:path')

const FIXTURE_HOSTS = Object.freeze([
  'login.vast-test.local',
  'spa.vast-test.local',
  'dynamic.vast-test.local',
  'iframe.vast-test.local'
])

const TARGETS = Object.freeze({
  bitwarden: Object.freeze({
    key: 'bitwarden',
    sourceDirectory: 'extension-reference/bitwarden',
    popup: 'popup/index.html',
    expectedUpstreamId: 'nngceckbapebfimnlniiiahkandclblb',
    crxEnv: 'VAST_BITWARDEN_CRX',
    defaultCrx: 'extension-reference/bitwarden.crx'
  }),
  protonpass: Object.freeze({
    key: 'protonpass',
    sourceDirectory: 'extension-reference/protonpass',
    popup: 'popup.html',
    expectedUpstreamId: 'ghmbeldphafepmbegfdlkpapadhbakde',
    crxEnv: 'VAST_PROTON_PASS_CRX',
    defaultCrx: 'extension-reference/protonpass.crx'
  })
})

const MODE_TARGETS = Object.freeze({
  bitwarden: Object.freeze(['bitwarden']),
  proton: Object.freeze(['protonpass']),
  combined: Object.freeze(['bitwarden', 'protonpass'])
})

const DEFAULT_FIXTURE_PORTS = Object.freeze({
  bitwarden: 54443,
  proton: 54444,
  combined: 54445
})

const COMMANDS = new Set(['prepare', 'run', 'resume', 'status', 'verify', 'stop', 'restart', 'record-reload', 'confirm-autofill', 'confirm-suggestion', 'tls-setup', 'tls-remove'])

function parseGateArgs(argv = process.argv.slice(2), _env = process.env) {
  const values = [...argv]
  const command = values.shift()
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command || '(missing)'}`)

  let mode
  let dryRun = false
  let buildVast = false
  let exploratory = false
  let runId
  let operatorConfirmed = false
  while (values.length > 0) {
    const value = values.shift()
    if (value === '--dry-run') dryRun = true
    else if (value === '--build-vast') buildVast = true
    else if (value === '--exploratory') exploratory = true
    else if (value === '--operator-confirmed') operatorConfirmed = true
    else if (value === '--run-id') {
      runId = values.shift()
      if (!runId) throw new Error('--run-id requires a value.')
    } else if (value.startsWith('--run-id=')) {
      runId = value.slice('--run-id='.length)
      if (!runId) throw new Error('--run-id requires a value.')
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown argument: ${value}`)
    } else if (!mode) {
      mode = value
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }

  if (mode && !Object.hasOwn(MODE_TARGETS, mode)) throw new Error(`Unknown mode: ${mode}`)
  if (operatorConfirmed && !['confirm-autofill', 'confirm-suggestion'].includes(command)) throw new Error('--operator-confirmed is only valid for confirmation commands.')
  if (['confirm-autofill', 'confirm-suggestion'].includes(command) && (dryRun || buildVast)) throw new Error('Build and dry-run flags are not valid for confirmation commands.')
  if (exploratory && !['prepare', 'run'].includes(command)) throw new Error('--exploratory is only valid for prepare and run commands.')
  return { command, mode, dryRun, buildVast, runId,
    ...(operatorConfirmed ? { operatorConfirmed } : {}), ...(exploratory ? { exploratory } : {}) }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function readManifest(sourcePath, targetKey) {
  const manifestPath = path.join(sourcePath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`Source manifest for ${targetKey} does not exist: ${manifestPath}`)
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`Source manifest for ${targetKey} is invalid JSON: ${error.message}`)
  }
  if (manifest.manifest_version !== 3) throw new Error(`${targetKey} must be an official Manifest V3 extension.`)
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error(`${targetKey} manifest has no version.`)
  return manifest
}

function resolveGateConfig(root, args, env = process.env) {
  const resolvedRoot = path.resolve(root)
  if (!args.mode || !Object.hasOwn(MODE_TARGETS, args.mode)) {
    throw new Error(`Unknown mode: ${args.mode || '(missing)'}`)
  }

  const gateRoot = path.join(resolvedRoot, '.vast-build', 'password-manager-gates')
  const profileRoots = Object.fromEntries(
    Object.keys(MODE_TARGETS).map((mode) => [mode, path.join(gateRoot, 'profiles', mode)])
  )
  if (new Set(Object.values(profileRoots).map((item) => path.resolve(item).toLowerCase())).size !== Object.keys(profileRoots).length) {
    throw new Error('Password-manager gate modes reuse a profile path.')
  }

  const patchedDist = path.resolve(env.VAST_PATCHED_ELECTRON_DIST || 'D:\\VastElectron44\\src\\out\\VastCompat')
  const executableName = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const electronExecutable = path.resolve(env.VAST_PATCHED_ELECTRON_EXE || path.join(patchedDist, executableName))
  if (!isWithin(patchedDist, electronExecutable)) {
    throw new Error('The Electron executable must be inside VAST_PATCHED_ELECTRON_DIST.')
  }
  if (!fs.existsSync(electronExecutable)) throw new Error(`Patched Electron executable does not exist: ${electronExecutable}`)

  const targets = MODE_TARGETS[args.mode].map((targetName) => {
    const definition = TARGETS[targetName]
    const sourcePath = path.resolve(resolvedRoot, definition.sourceDirectory)
    const crxValue = env[definition.crxEnv] || path.join(resolvedRoot, definition.defaultCrx)
    if (!path.isAbsolute(crxValue)) throw new Error(`${definition.crxEnv} must be an absolute CRX path.`)
    const crxPath = path.resolve(crxValue)
    if (!fs.existsSync(crxPath)) throw new Error(`Official CRX for ${definition.key} does not exist: ${crxPath}`)
    const manifest = readManifest(sourcePath, definition.key)
    return Object.freeze({ ...definition, sourcePath, crxPath, manifest })
  })

  const configuredFixturePort = env.VAST_GATE_FIXTURE_PORT === undefined
    ? DEFAULT_FIXTURE_PORTS[args.mode]
    : Number.parseInt(env.VAST_GATE_FIXTURE_PORT, 10)
  if (!Number.isSafeInteger(configuredFixturePort) || configuredFixturePort < 1024 || configuredFixturePort > 65535 ||
      (env.VAST_GATE_FIXTURE_PORT !== undefined && String(configuredFixturePort) !== env.VAST_GATE_FIXTURE_PORT.trim())) {
    throw new Error('VAST_GATE_FIXTURE_PORT must be an integer from 1024 through 65535.')
  }

  return Object.freeze({
    root: resolvedRoot,
    gateRoot,
    mode: args.mode,
    profile: profileRoots[args.mode],
    fixturePort: configuredFixturePort,
    targets: Object.freeze(targets),
    patchedDist,
    electronExecutable
  })
}

module.exports = { DEFAULT_FIXTURE_PORTS, FIXTURE_HOSTS, MODE_TARGETS, TARGETS, parseGateArgs, resolveGateConfig }
