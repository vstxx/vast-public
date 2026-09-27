function packagedMainContains(asar, archivePath, value) {
  return asar.listPackage(archivePath)
    .filter((entry) => /^\/out\/main\/.+\.js$/i.test(entry.replaceAll('\\', '/')))
    .some((entry) => asar.extractFile(archivePath, entry.slice(1)).toString('utf8').includes(value))
}

module.exports = { packagedMainContains }
