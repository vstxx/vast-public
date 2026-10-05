// Immutable deliverables shared by sealing, package verification and publication.
function usesSplitStableFeed(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  return parts[0] > 0 || parts[1] > 4 || (parts[1] === 4 && parts[2] >= 3)
}
function requiredReleaseFiles(version, unsigned = false) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version')
  return [
    `Installer/Vast-Setup-${version}.exe`,
    `Installer/Vast-Setup-${version}.exe.blockmap`,
    `Installer/Vast-${version}-Portable.exe`,
    'Installer/latest.yml',
    ...(usesSplitStableFeed(version) ? ['Installer/stable-v2.yml'] : []),
    `Updater/VastUpdater-${version}.exe`,
    'Downloads/update-manifest.json',
    `Downloads/Vast-${version}-update.zip`,
    'Checksums/SHA256SUMS.txt', 'Checksums/SHA512SUMS.txt', 'Checksums/checksums.json',
    'Docs/release-manifest.json', 'Docs/data-migration-and-storage.md',
    'Docs/ffmpeg-build-provenance.json', 'Docs/avidae-ffmpeg-capabilities.json',
    'Source/ffmpeg-corresponding-source-win64.tar.zst', 'README.md', 'version.json',
    ...(unsigned ? ['PUBLIC-UNSIGNED-RELEASE.md'] : [])
  ].sort()
}
function publishedReleaseFiles(version, unsigned = false) {
  // Supporting documentation is retained in the candidate but is not a public release asset.
  return requiredReleaseFiles(version, unsigned).filter(file => !['README.md', 'Docs/data-migration-and-storage.md'].includes(file))
}
function candidatePaths(version, unsigned) {
  return [...requiredReleaseFiles(version, unsigned).map(file => `release/${file}`), 'out/release-build-metadata.json'].sort()
}
module.exports = { requiredReleaseFiles, publishedReleaseFiles, candidatePaths, usesSplitStableFeed }
