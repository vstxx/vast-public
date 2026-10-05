const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { publicSourceCommitMessage, snapshotDigest } = require('./local-public-release.cjs')
const snapshot = path.resolve(process.argv[2] || '')
const provenance = JSON.parse(fs.readFileSync(path.join(snapshot, '.vast-source-provenance.json'), 'utf8'))
const version = require('../package.json').version
if (provenance.worktreePreview || provenance.version !== version || provenance.sourceCommit !== process.env.VAST_RELEASE_COMMIT) throw new Error('Only an audited exact-commit snapshot may be published.')
const expectedSnapshotDigest = String(process.env.VAST_PUBLIC_SNAPSHOT_SHA256 || '').trim()
function verifySnapshotDigest() {
  if (expectedSnapshotDigest && snapshotDigest(snapshot) !== expectedSnapshotDigest) throw new Error('Audited source snapshot bytes changed after preparation.')
}
verifySnapshotDigest()
function run(command, args, cwd, binary = false) {
  const result = spawnSync(command, args, { cwd, encoding: binary ? null : 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`)
  return result.stdout
}
// Recheck at the publication boundary, including when resuming an existing tag.
run(process.execPath, [path.join(snapshot, 'scripts/public-release-audit.cjs')], snapshot)
run(process.execPath, [path.join(__dirname, 'secret-scan.cjs'), snapshot], snapshot)
verifySnapshotDigest()
run('gh', ['auth', 'setup-git', '--hostname', 'github.com'])
const repo = path.join(fs.mkdtempSync(path.join(tmpdir(), 'vast-public-publish-')), 'repo')
run('gh', ['repo', 'clone', 'vstxx/vast-public', repo])
run('git', ['config', 'core.autocrlf', 'false'], repo)
// Preserve the human-maintained public landing page separately from exact release source tags.
const publicReadme = run('git', ['show', 'HEAD:README.md'], repo, true)
if (!publicReadme.length) throw new Error('Public repository README is missing; refusing to replace it.')
const tag = `v${version}`
function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort()
}
if (run('git', ['tag', '--list', tag], repo).trim()) {
  const existing = run('git', ['ls-tree', '-r', '--name-only', tag], repo).trim().split('\n').sort()
  if (JSON.stringify(existing) !== JSON.stringify(walk(snapshot))) throw new Error('Existing public tag contains a different source tree.')
  for (const file of existing) {
    const before = run('git', ['show', `${tag}:${file}`], repo, true)
    const after = fs.readFileSync(path.join(snapshot, file))
    if (file === '.vast-source-provenance.json') {
      const a = JSON.parse(before), b = JSON.parse(after)
      delete a.exportedAt; delete b.exportedAt
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Existing public tag provenance differs.')
    } else if (!before.equals(after)) throw new Error(`Existing public tag differs at ${file}; immutable tag will not be changed.`)
  }
  console.log(`Verified existing ${tag}; source publication already complete.`)
} else {
  // Windows clone checkout may have CRLF changes before core.autocrlf is disabled above.
  // This is a fresh throwaway clone; replace its tracked files with the audited snapshot.
  run('git', ['rm', '-r', '--force', '--ignore-unmatch', '.'], repo)
  fs.cpSync(snapshot, repo, { recursive: true })
  run('git', ['add', '-A'], repo)
  run('git', ['config', 'user.name', 'Vast Release Bot'], repo)
  run('git', ['config', 'user.email', 'release@vastbrowser.com'], repo)
  run('git', ['commit', '-m', publicSourceCommitMessage(version, provenance.sourceCommit)], repo)
  run('git', ['tag', '-a', tag, '-m', `Vast ${version} from ${provenance.sourceCommit}`], repo)
  // Keep the tag's audited source tree exact; restore the existing public README only on main.
  fs.writeFileSync(path.join(repo, 'README.md'), publicReadme)
  run('git', ['add', '--', 'README.md'], repo)
  if (run('git', ['diff', '--cached', '--name-only', '--', 'README.md'], repo).trim()) {
    run('git', ['commit', '-m', `Preserve public README after Vast ${version} snapshot publication`], repo)
  }
  run('git', ['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${tag}`], repo)
}
