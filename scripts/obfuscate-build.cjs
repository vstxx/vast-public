const { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { basename, join, relative } = require('node:path')
const JavaScriptObfuscator = require('javascript-obfuscator')

const rootDir = join(__dirname, '..')
const outputDirs = [join(rootDir, 'out', 'main'), join(rootDir, 'out', 'renderer', 'assets')]
const protectedRendererChunks = [/^PasswordsPage-/i]

function collectJavaScriptFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) collectJavaScriptFiles(fullPath, files)
    else if (/\.(cjs|mjs|js)$/.test(entry) && !/pdf\.worker/i.test(entry)) files.push(fullPath)
  }
  return files
}

function profileFor(filePath) {
  const rel = relative(rootDir, filePath).replaceAll('\\', '/')
  if (rel.startsWith('out/main/')) return 'main-light'
  if (protectedRendererChunks.some((pattern) => pattern.test(basename(filePath)))) return 'protected'
  return 'none'
}

const shared = {
  compact: true,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  unicodeEscapeSequence: false,
  seed: 1337
}

function optionsFor(profile) {
  if (profile === 'main-light') {
    return {
      ...shared,
      controlFlowFlattening: false,
      numbersToExpressions: false,
      simplify: true,
      splitStrings: false,
      stringArray: false,
      transformObjectKeys: false
    }
  }
  return {
    ...shared,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.18,
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.25,
    stringArrayEncoding: ['base64'],
    stringArrayIndexesType: ['hexadecimal-number'],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.42,
    transformObjectKeys: true
  }
}

function processFile(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const profile = profileFor(filePath)
  if (profile === 'none') {
    return { file: relative(rootDir, filePath), profile, before: Buffer.byteLength(source), after: Buffer.byteLength(source) }
  }
  const output = JavaScriptObfuscator.obfuscate(source, optionsFor(profile)).getObfuscatedCode()
  writeFileSync(filePath, output, 'utf8')
  return { file: relative(rootDir, filePath), profile, before: Buffer.byteLength(source), after: Buffer.byteLength(output) }
}

const results = outputDirs.flatMap((dir) => collectJavaScriptFiles(dir)).map(processFile)
const report = {
  schemaVersion: 1,
  strategy: 'startup-selective-v1',
  protectedProfiles: ['main-light', 'protected'],
  files: results
}
mkdirSync(join(rootDir, 'out'), { recursive: true })
writeFileSync(join(rootDir, 'out', 'obfuscation-report.json'), `${JSON.stringify(report, null, 2)}\n`)

for (const result of results) {
  console.log(`${result.profile.padEnd(10)} ${result.file} ${result.before} -> ${result.after} bytes`)
}
console.log(`selectively protected ${results.filter((result) => result.profile !== 'none').length} of ${results.length} JavaScript bundles`)
