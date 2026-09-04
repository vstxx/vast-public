const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { isAbsolute, join, resolve } = require('node:path')

const root = join(__dirname, '..')
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

function usage() {
  console.error('Usage: node scripts/local-release-from-env.cjs [npm-script] [--env-file .env.release.local] [--internal-unsigned|--public-unsigned-release]')
  process.exit(1)
}

const args = process.argv.slice(2)
let target = 'dist:upgrader'
let envFile = join(root, '.env.release.local')
let internalUnsigned = false
let publicUnsignedRelease = false

for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--help' || arg === '-h') usage()
  if (arg === '--internal-unsigned') {
    internalUnsigned = true
    continue
  }
  if (arg === '--public-unsigned-release') {
    publicUnsignedRelease = true
    continue
  }
  if (arg === '--env-file') {
    const next = args[index + 1]
    if (!next) usage()
    envFile = isAbsolute(next) ? next : resolve(root, next)
    index += 1
    continue
  }
  if (arg.startsWith('--env-file=')) {
    const value = arg.slice('--env-file='.length)
    envFile = isAbsolute(value) ? value : resolve(root, value)
    continue
  }
  if (arg.startsWith('-')) usage()
  target = arg
}

function parseEnvFile(path) {
  const parsed = {}
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) throw new Error(`Invalid env line in ${path}: ${rawLine}`)
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
      if (match[2].trim().startsWith('"')) value = value.replace(/\\n/g, '\n')
    }
    parsed[match[1]] = value
  }
  return parsed
}

function flag(env, name, fallback = false) {
  const value = String(env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

if (!existsSync(envFile)) {
  console.error(`Missing ${envFile}. Copy .env.release.example to .env.release.local and fill in local values.`)
  process.exit(1)
}

const fileEnv = parseEnvFile(envFile)
const env = { ...process.env, ...fileEnv }
env.VAST_DISTRIBUTION_CHANNEL = 'direct'

if (internalUnsigned && publicUnsignedRelease) {
  throw new Error('Internal unsigned and public unsigned release modes are mutually exclusive.')
}

if (internalUnsigned) {
  env.VAST_RELEASE_CHANNEL = 'beta'
  env.VAST_PRIVATE_BUILD = '1'
  env.VAST_UPDATE_ENABLED = '1'
  env.VAST_OBFUSCATE = '1'
  env.VAST_ALLOW_UNSIGNED_PRIVATE_BUILD = '1'
  // An example or developer env file may contain placeholder signing values.
  // Never let those values make the explicitly private QA package attempt to
  // discover or load a certificate.
  delete env.WIN_CSC_LINK
  delete env.CSC_LINK
  delete env.WIN_CSC_KEY_PASSWORD
  delete env.CSC_KEY_PASSWORD
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

if (publicUnsignedRelease) {
  env.VAST_RELEASE_CHANNEL = env.VAST_RELEASE_CHANNEL || 'stable'
  env.VAST_PRIVATE_BUILD = '0'
  env.VAST_UPDATE_ENABLED = '1'
  env.VAST_OBFUSCATE = '1'
  env.VAST_PUBLIC_UNSIGNED_RELEASE = '1'
  env.VAST_UNSIGNED_RELEASE_ACK = 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
  delete env.WIN_CSC_LINK
  delete env.CSC_LINK
  delete env.WIN_CSC_KEY_PASSWORD
  delete env.CSC_KEY_PASSWORD
  delete env.VAST_EXPECTED_SIGNER_SUBJECT
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

const failures = []
function requireExact(name, expected) {
  if (String(env[name] ?? '').trim() !== expected) failures.push(`${name} must be ${expected}`)
}

requireExact('VAST_RELEASE_REPO', 'vstxx/vast-public')
requireExact('VAST_UPDATE_ENABLED', '1')
requireExact('VAST_OBFUSCATE', '1')

if (internalUnsigned) {
  requireExact('VAST_RELEASE_CHANNEL', 'beta')
  requireExact('VAST_PRIVATE_BUILD', '1')
} else {
  if (!['beta', 'stable'].includes(String(env.VAST_RELEASE_CHANNEL ?? '').trim())) {
    failures.push('VAST_RELEASE_CHANNEL must be beta or stable for a public distribution')
  }
  requireExact('VAST_PRIVATE_BUILD', '0')
  if (!publicUnsignedRelease && !String(env.VAST_EXPECTED_SIGNER_SUBJECT ?? '').trim()) {
    failures.push('VAST_EXPECTED_SIGNER_SUBJECT is required for a public distribution')
  }
  if (publicUnsignedRelease) {
    requireExact('VAST_PUBLIC_UNSIGNED_RELEASE', '1')
    requireExact('VAST_UNSIGNED_RELEASE_ACK', 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK')
  }

  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const gitStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (gitHead.status !== 0 || !/^[a-f0-9]{40}$/i.test(String(gitHead.stdout).trim())) {
    failures.push('public distribution must be built from a Git commit')
  } else {
    const head = String(gitHead.stdout).trim().toLowerCase()
    if (env.VAST_RELEASE_COMMIT && String(env.VAST_RELEASE_COMMIT).trim().toLowerCase() !== head) {
      failures.push('VAST_RELEASE_COMMIT must match the checked-out HEAD')
    }
    env.VAST_RELEASE_COMMIT = head
  }
  if (gitStatus.status !== 0 || String(gitStatus.stdout).trim()) {
    failures.push('public distribution requires a clean worktree; commit all release changes first')
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, envFile, target, failures }, null, 2))
  process.exit(1)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      envFile,
      target,
      releaseChannel: env.VAST_RELEASE_CHANNEL,
      privateBuild: flag(env, 'VAST_PRIVATE_BUILD', true),
      sourceCommit: env.VAST_RELEASE_COMMIT || null,
      internalUnsigned,
      publicUnsignedRelease
    },
    null,
    2
  )
)

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const useShell = process.platform === 'win32'

function quoteShellArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

const spawnCommand = useShell ? [npmCommand, 'run', target].map(quoteShellArg).join(' ') : npmCommand
const spawnArgs = useShell ? [] : ['run', target]
const result = spawnSync(spawnCommand, spawnArgs, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: useShell
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
