// Private staging only. No public-repository writes and no binary build commands.
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { createReadStream, createWriteStream } = fs
const { pipeline } = require('node:stream/promises')
const { Transform } = require('node:stream')
const { verifyTree, validateManifest, digest, identity, manifestName } = require('./release-candidate.cjs')
const repo = 'vstxx/vast'
const prefix = `repos/${repo}`
const assetLimit = 2 * 1024 ** 3
function candidateTag(info) { return `candidate-v${info.version}-${info.channel}-${info.unsigned ? 'unsigned' : 'signed'}-${info.sourceCommit}` }
function validateRun(run, info, workflow, completed) {
  if (!run || run.head_sha !== info.sourceCommit || run.path !== workflow || run.event !== 'workflow_dispatch' || (completed && run.status !== 'completed')) throw new Error('Candidate must come from a completed manual run of this workflow at the exact same source SHA')
}
function checkRelease(release, info, manifestHash) {
  let record
  try { record = JSON.parse(release.body) } catch { throw new Error('Existing candidate has invalid staging provenance') }
  if (!release.draft || release.tag_name !== candidateTag(info) || release.target_commitish !== info.sourceCommit || record.schema !== 1 || record.manifestSha256 !== manifestHash || !/^\d+$/.test(record.producerRunId)) throw new Error('Existing private candidate differs; immutable bytes will not be overwritten')
  return record
}
function checkAssets(assets, manifest, manifestFile) {
  const expected = [...manifest.files, { path: manifestName, asset: manifestName, sha256: digest(manifestFile), bytes: fs.statSync(manifestFile).size }]
  const seen = new Set()
  for (const asset of assets) {
    const file = expected.find(file => file.asset === asset.name)
    if (!file || seen.has(asset.name) || asset.state !== 'uploaded' || asset.size !== file.bytes) throw new Error(`Unexpected/incomplete private candidate asset: ${asset.name}; refusing overwrite`)
    seen.add(asset.name)
  }
  return expected
}
async function operate({ command, directory, info, runId, api, upload, download, publicationVerified = false }) {
  if (!['store', 'restore', 'cleanup'].includes(command)) throw new Error('Use private-release-candidate.cjs store|restore|cleanup')
  if (!/^\d+$/.test(runId || '')) throw new Error('A numeric candidate run ID is required')
  if ((await api('GET', `repos/${repo}`)).private !== true) throw new Error('Candidate storage repository must be private')
  const workflow = info.unsigned ? '.github/workflows/public-unsigned-beta.yml' : '.github/workflows/public-release.yml'
  validateRun(await api('GET', `${prefix}/actions/runs/${runId}`), info, workflow, command !== 'store')
  const tag = candidateTag(info)
  const refPath = `${prefix}/git/refs/tags/${tag}`
  let ref = await api('GET', `${prefix}/git/ref/tags/${tag}`)
  if (ref && (ref.object?.type !== 'commit' || ref.object.sha !== info.sourceCommit)) throw new Error('Private candidate tag points to a different source commit')
  const releases = []
  for (let page = 1; ; page++) {
    const batch = await api('GET', `${prefix}/releases?per_page=100&page=${page}`)
    releases.push(...batch)
    if (batch.length < 100) break
  }
  const matches = releases.filter(release => release.tag_name === tag)
  if (matches.length > 1) throw new Error('Duplicate private candidate releases')
  let release = matches[0]
  const temporary = fs.mkdtempSync(path.join(tmpdir(), 'vast-private-candidate-'))
  try {
    if (command === 'cleanup') {
      if (!publicationVerified) throw new Error('Cleanup requires successful public verification')
      verifyTree(directory, info)
      if (release) {
        checkRelease(release, info, digest(path.join(directory, manifestName)))
        if (!ref) throw new Error('Candidate tag is missing')
        await api('DELETE', `${prefix}/releases/${release.id}`)
      }
      if (ref) await api('DELETE', refPath)
      return { tag, cleaned: true }
    }
    let manifest, manifestFile
    if (command === 'store') {
      manifest = verifyTree(directory, info)
      manifestFile = path.join(directory, manifestName)
    } else {
      if (!release || !ref) throw new Error('Private candidate is missing; restore the original staging candidate, never rebuild during publication')
      const assets = await api('GET', `${prefix}/releases/${release.id}/assets?per_page=100`)
      const candidates = assets.filter(asset => asset.name === manifestName)
      if (candidates.length !== 1 || candidates[0].size > 128 * 1024) throw new Error('Missing or invalid private candidate manifest')
      manifestFile = path.join(temporary, manifestName)
      await download(candidates[0], manifestFile)
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      validateManifest(manifest)
      for (const key of ['version', 'sourceCommit', 'channel', 'unsigned']) if (manifest[key] !== info[key]) throw new Error(`Candidate ${key} mismatch`)
    }
    const hash = digest(manifestFile)
    // Fail before creating any remote object if any asset exceeds GitHub's limit.
    for (const file of manifest.files) if (file.bytes >= assetLimit) throw new Error(`${file.path} is ${file.bytes} bytes; private release assets must be below 2 GiB`)
    if (release) {
      const record = checkRelease(release, info, hash)
      if (!ref) throw new Error('Candidate tag is missing')
      if (record.producerRunId !== runId) validateRun(await api('GET', `${prefix}/actions/runs/${record.producerRunId}`), info, workflow, true)
    } else {
      if (!ref) ref = await api('POST', `${prefix}/git/refs`, { ref: `refs/tags/${tag}`, sha: info.sourceCommit })
      release = await api('POST', `${prefix}/releases`, { tag_name: tag, target_commitish: info.sourceCommit, name: `Private candidate ${info.version} / ${info.channel} / ${info.sourceCommit}`, draft: true, prerelease: true, body: JSON.stringify({ schema: 1, producerRunId: runId, manifestSha256: hash }) })
      checkRelease(release, info, hash)
    }
    let assets = await api('GET', `${prefix}/releases/${release.id}/assets?per_page=100`)
    const expected = checkAssets(assets, manifest, manifestFile)
    // Verify ALL existing bytes before uploading anything missing. No --clobber.
    for (const asset of assets) {
      const target = path.join(temporary, `remote-${asset.id}`)
      await download(asset, target)
      if (digest(target) !== expected.find(file => file.asset === asset.name).sha256) throw new Error(`Existing candidate hash mismatch: ${asset.name}; refusing overwrite`)
      if (command === 'restore' && asset.name !== manifestName) {
        const relative = expected.find(file => file.asset === asset.name).path
        fs.mkdirSync(path.dirname(path.join(temporary, relative)), { recursive: true })
        fs.renameSync(target, path.join(temporary, relative))
      }
    }
    const missing = expected.filter(file => !assets.some(asset => asset.name === file.asset))
    if (command === 'restore') {
      if (missing.length) throw new Error(`Private candidate is incomplete: ${missing.map(file => file.asset).join(', ')}`)
      verifyTree(temporary, info)
      // Only write canonical paths into a fresh checkout, after all hashes pass.
      for (const file of expected) {
        if (fs.existsSync(path.join(directory, file.path))) throw new Error(`Restore destination already exists: ${file.path}`)
        let parent = directory
        for (const part of file.path.split('/').slice(0, -1)) {
          parent = path.join(parent, part)
          if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Restore destination contains a symlink')
        }
      }
      for (const file of expected) {
        const target = path.join(directory, file.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(temporary, file.path), target, fs.constants.COPYFILE_EXCL)
      }
      verifyTree(directory, info)
    } else {
      for (const file of missing) {
        await upload(release, path.join(directory, file.path), file.asset)
      }
      assets = await api('GET', `${prefix}/releases/${release.id}/assets?per_page=100`)
      checkAssets(assets, manifest, manifestFile)
      if (assets.length !== expected.length) throw new Error('Private candidate upload is incomplete')
      for (const file of missing) {
        const asset = assets.find(asset => asset.name === file.asset)
        const target = path.join(temporary, `uploaded-${asset.id}`)
        await download(asset, target)
        if (digest(target) !== file.sha256) throw new Error(`Uploaded candidate hash mismatch: ${file.asset}`)
      }
    }
    return { tag, files: expected.length, bytes: expected.reduce((sum, file) => sum + file.bytes, 0) }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
async function main() {
  const token = process.env.GH_TOKEN
  if (!token || process.env.GITHUB_REPOSITORY !== repo) throw new Error('Private candidate operations require this repository and its GITHUB_TOKEN')
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }
  async function api(method, endpoint, body) {
    const response = await fetch(`https://api.github.com/${endpoint}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) })
    if (method === 'GET' && response.status === 404 && /\/git\/ref\//.test(endpoint)) return null
    if (!response.ok) throw new Error(`Private candidate API ${method} ${endpoint}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  async function download(asset, target) {
    if (!new RegExp(`^https://api.github.com/repos/${repo}/releases/assets/[0-9]+$`).test(asset.url) || asset.size >= assetLimit) throw new Error('Unsafe candidate asset URL or size')
    const response = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(20 * 60_000) })
    if (!response.ok) throw new Error(`Candidate download failed: HTTP ${response.status}`)
    let bytes = 0
    const limit = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > asset.size ? new Error('Candidate asset exceeds declared size') : null, chunk) } })
    await pipeline(response.body, limit, createWriteStream(target, { flags: 'wx' }))
    if (bytes !== asset.size) throw new Error('Candidate download size mismatch')
  }
  async function upload(release, file, name) {
    const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(file).size) },
      body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(20 * 60_000)
    })
    if (!response.ok) throw new Error(`Candidate upload ${name}: HTTP ${response.status}; staging retained for investigation/resume`)
  }
  const result = await operate({ command: process.argv[2], directory: path.join(__dirname, '..'), info: identity(), runId: process.env.CANDIDATE_RUN_ID || process.env.GITHUB_RUN_ID, api, download, upload, publicationVerified: process.env.VAST_CANDIDATE_PUBLICATION_VERIFIED === '1' })
  console.log(JSON.stringify(result, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nPrivate candidate: ${result.tag}\n\n${result.files || 0} immutable assets, ${result.bytes || 0} bytes. No Actions artifact storage used.\n`)
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { operate, candidateTag, validateRun, checkRelease, checkAssets, assetLimit }
