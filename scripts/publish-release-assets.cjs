// Publication-only helper. Existing assets are compared byte-for-byte and never clobbered.
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream, appendFileSync } = require('node:fs')
const { basename } = require('node:path')
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr || result.error?.message}`)
  return result.stdout
}
async function hash(stream) { const result = createHash('sha256'); for await (const chunk of stream) result.update(chunk); return result.digest('hex') }
async function main() {
  const [notes, ...requested] = process.argv.slice(2)
  const assets = require('./release-files.cjs').publishedReleaseFiles(require('../package.json').version, process.env.VAST_PUBLIC_UNSIGNED_RELEASE === '1').map(file => `release/${file}`)
  if (requested.length) throw new Error('Publication assets must come from release-files.cjs, not caller-supplied paths')
  if (!notes || !assets.length) throw new Error('Pass a notes file and exact verified candidate assets.')
  const seal = spawnSync(process.execPath, [require.resolve('./release-candidate.cjs'), 'verify'], { stdio: 'inherit', windowsHide: true })
  if (seal.error || seal.status !== 0) throw new Error('Candidate changed since verification; refuse publication.')
  const version = require('../package.json').version, tag = `v${version}`, repo = 'vstxx/vast-public'
  const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat()
  let release = releases.find(item => item.tag_name === tag)
  const provenance = JSON.parse(Buffer.from(JSON.parse(gh(['api', `repos/${repo}/contents/.vast-source-provenance.json?ref=${tag}`])).content.replace(/\s/g, ''), 'base64'))
  if (provenance.version !== version || provenance.sourceCommit !== process.env.VAST_RELEASE_COMMIT || provenance.worktreePreview) throw new Error('Public tag has different source provenance; refusing publication.')
  if (!release) {
    gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', `Vast ${version}${process.env.VAST_PUBLIC_UNSIGNED_RELEASE === '1' ? ' — Public Unsigned Release' : ''}`, '--notes-file', notes, ...(process.env.VAST_RELEASE_CHANNEL === 'beta' ? ['--prerelease'] : [])])
    release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]))
  }
  if (release.prerelease !== (process.env.VAST_RELEASE_CHANNEL === 'beta')) throw new Error('Existing release channel differs from the candidate.')
  const missing = []
  // Validate all existing files first, before uploading any missing file.
  for (const file of assets) {
    const asset = release.assets.find(item => item.name === basename(file))
    if (!asset) { if (!release.draft) throw new Error(`Published release missing ${basename(file)}; manual investigation required.`); missing.push(file); continue }
    const response = await fetch(asset.url, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(600000) })
    if (!response.ok || await hash(response.body) !== await hash(createReadStream(file))) throw new Error(`Existing ${asset.name} hash mismatch; assets are immutable. Resume the original candidate.`)
  }
  for (const file of missing) gh(['release', 'upload', tag, file, '--repo', repo])
  if (!release.draft && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, 'VAST_RELEASE_ALREADY_PUBLIC=true\n')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
