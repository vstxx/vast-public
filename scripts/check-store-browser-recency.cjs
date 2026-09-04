const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { dirname, join } = require('node:path')
const { root } = require('./store-msix-config.cjs')

const CHROME_VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json'
const policyPath = join(__dirname, 'store-browser-policy.json')

function readPolicy() {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
  if (policy?.schemaVersion !== 1 || typeof policy.reviewedAt !== 'string' ||
      !Number.isInteger(policy.maximumReviewAgeDays) || !Number.isInteger(policy.maximumChromiumMajorLag) ||
      typeof policy.upstreamStableVersion !== 'string' || policy.upstreamSource !== CHROME_VERSIONS_URL) {
    throw new Error('Store browser policy metadata is malformed or uses an unsupported schema.')
  }
  return policy
}

function major(value) {
  const match = /^(\d+)\./.exec(String(value))
  if (!match) throw new Error(`Invalid browser version: ${value}`)
  return Number(match[1])
}

function recencyReport(currentChromiumVersion, latestStableVersion, now = Date.now(), policy = readPolicy()) {
  const currentMajor = major(currentChromiumVersion)
  const latestStableMajor = major(latestStableVersion)
  const majorLag = latestStableMajor - currentMajor
  const reviewedAt = Date.parse(`${policy.reviewedAt}T00:00:00Z`)
  const policyReviewAgeDays = Math.floor((now - reviewedAt) / 86_400_000)
  return {
    ok: majorLag >= 0 && majorLag <= policy.maximumChromiumMajorLag && policyReviewAgeDays >= 0 && policyReviewAgeDays <= policy.maximumReviewAgeDays,
    currentChromiumVersion,
    currentChromiumMajor: currentMajor,
    latestStableVersion,
    latestStableMajor,
    majorLag,
    maximumAllowedMajorLag: policy.maximumChromiumMajorLag,
    policyReviewedAt: policy.reviewedAt,
    policyReviewAgeDays,
    maximumPolicyReviewAgeDays: policy.maximumReviewAgeDays,
    source: policy.upstreamSource
  }
}

async function main() {
  const current = process.versions.chrome
  if (!current) throw new Error('The browser recency gate must run under Electron so process.versions.chrome is authoritative.')
  let policy = readPolicy()
  if (process.argv.includes('--refresh')) {
    const response = await fetch(CHROME_VERSIONS_URL, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Chrome for Testing version endpoint returned HTTP ${response.status}.`)
    const body = await response.json()
    const latest = body?.channels?.Stable?.version
    if (typeof latest !== 'string') throw new Error('Chrome for Testing response did not include the Stable version.')
    policy = {
      ...policy,
      reviewedAt: new Date().toISOString().slice(0, 10),
      upstreamStableVersion: latest
    }
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
  }
  const report = recencyReport(current, policy.upstreamStableVersion, Date.now(), policy)
  const outputPath = join(root, 'release', 'store', 'browser-recency.json')
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, outputPath }, null, 2))
  if (!report.ok) process.exit(1)
}

if (require.main === module && !process.versions.chrome) {
  const electronExecutable = require('electron')
  const child = spawnSync(electronExecutable, [__filename, ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true
  })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
} else if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

module.exports = { CHROME_VERSIONS_URL, major, readPolicy, recencyReport }
