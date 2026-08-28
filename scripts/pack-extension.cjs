const { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } = require('node:fs/promises')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

function argumentValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

function safeFilename(value) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'extension'
}

function isInside(root, candidate) {
  const next = relative(root, candidate)
  return next === '' || (next !== '..' && !next.startsWith(`..${sep}`) && !isAbsolute(next))
}

async function collectFiles(root, normalizeVextPath) {
  const files = new Map()
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Symlinks are not supported in .vext packages: ${relative(root, absolute)}.`)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') throw new Error(`Remove ${entry.name} from the extension directory before packaging.`)
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) throw new Error(`Special filesystem entries are not supported: ${relative(root, absolute)}.`)
      const canonical = await realpath(absolute)
      if (!isInside(root, canonical)) throw new Error(`Extension file escapes its source directory: ${entry.name}.`)
      const packagePath = normalizeVextPath(relative(root, absolute).split(sep).join('/'))
      files.set(packagePath, new Uint8Array(await readFile(canonical)))
    }
  }
  await visit(root)
  return files
}

async function main() {
  const args = process.argv.slice(2)
  const valueOptions = new Set(['--out', '--extension-id', '--publisher-id'])
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (valueOptions.has(value)) { index += 1; continue }
    if (value.startsWith('--')) throw new Error(`Unknown option: ${value}.`)
    positional.push(value)
  }
  if (positional.length > 2) throw new Error('Too many positional arguments.')
  const sourceArg = positional[0]
  if (!sourceArg) throw new Error('Usage: npm run extension:pack -- <extension-directory> [--out file.vext] [--extension-id id] [--publisher-id id]')
  const source = await realpath(resolve(sourceArg))
  if (!(await stat(source)).isDirectory()) throw new Error('Extension source must be a directory.')
  const [{ validateExtensionManifest, chromeExtensionId }, format] = await Promise.all([
    import('../src/main/extensions/extension-manifest.ts'),
    import('../src/shared/vext-format.ts')
  ])
  const validated = await validateExtensionManifest(source)
  const declaredId = validated.vast && typeof validated.manifest.vast?.extension_id === 'string' ? validated.manifest.vast.extension_id : undefined
  const extensionId = argumentValue(args, '--extension-id') || declaredId || chromeExtensionId(source, validated.manifest.key)
  if (!format.VEXT_EXTENSION_ID.test(extensionId)) throw new Error('Managed extension ID must contain exactly 32 letters in the a-p range.')
  const publisherArg = argumentValue(args, '--publisher-id')
  const publisherId = publisherArg || null
  const files = await collectFiles(source, format.normalizeVextPath)
  const bytes = await format.createVextPackage({ extensionId, version: validated.manifest.version, publisherId, files })
  await format.parseVextPackage(bytes)
  const outputArg = argumentValue(args, '--out') || positional[1]
  const output = resolve(outputArg || join(dirname(source), `${safeFilename(validated.manifest.name)}-${validated.manifest.version}.vext`))
  if (isInside(source, output)) throw new Error('Write the .vext package outside the extension source directory.')
  const outputDirectory = dirname(output)
  await mkdir(outputDirectory, { recursive: true })
  const temporaryRoot = await mkdtemp(join(outputDirectory, '.vast-vext-pack-'))
  try {
    const temporary = join(temporaryRoot, 'package.vext')
    await writeFile(temporary, bytes)
    await rename(temporary, output)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  process.stdout.write(`${output}\n`)
}

main().catch((error) => {
  process.stderr.write(`Could not create Vast Extension Package: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
