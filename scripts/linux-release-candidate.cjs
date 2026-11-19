// Keeps the verified Linux AppImage as a private draft release in this
// repository between the candidate build and its publication, like the
// Windows candidate (scripts/private-release-candidate.cjs).
//   store    (Linux candidate job)  release/ -> private draft
//   attach   (publish run)          private draft from the same candidate run -> public draft release
//   cleanup  (after public verification)
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const command = process.argv[2]
const version = require(path.join(root, 'package.json')).version
const channel = process.env.VAST_RELEASE_CHANNEL
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT || process.env.GITHUB_SHA || '').toLowerCase()
const repository = process.env.GITHUB_REPOSITORY
const token = process.env.CANDIDATE_TOKEN
const files = [`Vast-${version}-x86_64.AppImage`, 'latest-linux.yml', 'SHA256SUMS-linux.txt']
const tag = `candidate-linux-v${version}-${channel}-${sourceCommit}`
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

async function api(method, url, body, headers = {}) {
  const response = await fetch(url.startsWith('https://') ? url : `https://api.github.com/repos/${repository}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...headers },
    body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status}`)
  return response
}

async function findDraft() {
  for (let page = 1; page <= 10; page++) {
    const releases = await (await api('GET', `/releases?per_page=100&page=${page}`)).json()
    const found = releases.find((release) => release.tag_name === tag)
    if (found) {
      if (!found.draft) throw new Error(`${tag} is not a draft; refusing to use it`)
      return found
    }
    if (releases.length < 100) return null
  }
  return null
}

async function store() {
  if (process.env.VAST_EXPECTED_VERSION && process.env.VAST_EXPECTED_VERSION !== version) throw new Error('Version mismatch')
  const local = Object.fromEntries(files.map((name) => [name, sha256(path.join(root, 'release', name))]))
  // A candidate that was never published may be replaced by a newer run.
  const existing = await findDraft()
  if (existing) await api('DELETE', `/releases/${existing.id}`)
  const release = await (await api('POST', '/releases', {
    tag_name: tag, target_commitish: sourceCommit, draft: true, prerelease: true,
    name: `Private Linux candidate ${version} / ${channel} / ${sourceCommit}`,
    body: JSON.stringify({ schema: 1, producerRunId: String(process.env.GITHUB_RUN_ID), files: local })
  })).json()
  for (const name of files) {
    const upload = release.upload_url.replace(/\{.*$/, `?name=${encodeURIComponent(name)}`)
    await api('POST', upload, fs.readFileSync(path.join(root, 'release', name)), { 'Content-Type': 'application/octet-stream' })
  }
  console.log(`Stored ${tag}`)
}

async function attach() {
  const release = await findDraft()
  if (!release) throw new Error(`Missing private Linux candidate ${tag}`)
  const record = JSON.parse(release.body)
  if (record.schema !== 1 || record.producerRunId !== String(process.env.CANDIDATE_RUN_ID)) throw new Error('The Linux candidate was not produced by the candidate run being published')
  const directory = path.join(root, 'release', 'Linux')
  fs.mkdirSync(directory, { recursive: true })
  if (release.assets.length !== files.length) throw new Error('Unexpected or missing Linux candidate assets')
  for (const name of files) {
    const asset = release.assets.find((item) => item.name === name)
    if (!asset) throw new Error(`Linux candidate is missing ${name}`)
    const bytes = Buffer.from(await (await api('GET', asset.url, undefined, { Accept: 'application/octet-stream' })).arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== record.files[name]) throw new Error(`${name} does not match its candidate checksum`)
    fs.writeFileSync(path.join(directory, name), bytes)
  }
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS-linux.txt'), 'utf8').trim().split('\n')) {
    const [hash, name] = line.trim().split(/\s+\*?/)
    if (record.files[name] !== hash) throw new Error(`SHA256SUMS-linux.txt disagrees for ${name}`)
  }
  const result = spawnSync('gh', ['release', 'upload', `v${version}`, ...files.map((name) => path.join(directory, name)), '--repo', 'vstxx/vast-public'], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Could not attach the Linux AppImage to the public draft release')
  console.log(`Attached ${files.join(', ')}`)
}

async function cleanup() {
  const release = await findDraft()
  if (release) await api('DELETE', `/releases/${release.id}`)
  console.log(release ? `Removed ${tag}` : `No ${tag} to remove`)
}

if (!['store', 'attach', 'cleanup'].includes(command) || !token || !repository || !['beta', 'stable'].includes(channel) || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
  console.error('Usage: linux-release-candidate.cjs store|attach|cleanup with CANDIDATE_TOKEN, GITHUB_REPOSITORY, VAST_RELEASE_CHANNEL and a full VAST_RELEASE_COMMIT')
  process.exit(1)
}
;({ store, attach, cleanup })[command]().catch((error) => { console.error(error.message); process.exit(1) })
