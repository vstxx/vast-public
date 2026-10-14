#!/usr/bin/env node
// Run only after the 44.7.0 compatibility manifest has been populated from a
// real, verified Vast build. Profiles and logs are retained for crash analysis.
const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { isAbsolute, join, resolve } = require('node:path')
const { classifyCwsRun } = require('./cws-acceptance-policy.cjs')

const root = resolve(__dirname, '..', '..')
const historicalUrl = 'https://chromewebstore.google.com/detail/idu+/nckhacbgboonmhekihinhokldoogagoh?hl=pl'
const otherUrl = 'https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh'
const homepageUrl = 'https://chromewebstore.google.com/'

function option(name, fallback) {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

function hashPatchset(patches) {
  const hash = createHash('sha256')
  for (const patch of patches) {
    const relativePath = patch.path.replaceAll('\\', '/')
    const bytes = readFileSync(join(root, relativePath))
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== patch.sha256) throw new Error(`Patch changed: ${relativePath}`)
    hash.update(relativePath, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(bytes)
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

function runCase(binary, output, item, approved) {
  return new Promise((resolveRun) => {
    const { name: caseName, url: cwsUrl, id: expectedExtensionId, homepage: expectedHomepage } = item
    const profile = join(tmpdir(), `vast-cws-acceptance-${caseName}-${randomUUID()}`)
    const resultPath = join(output, `${caseName}.json`)
    const logPath = join(output, `${caseName}.log`)
    const scenario = { name: caseName, mode: item.mode || 'stock', extension: item.extension || 'none', productionEce: item.mode === 'ece', cws: true, cwsUrl, cwsStableMs: 60_000 }
    const args = [join(__dirname, 'harness-main.cjs'), `--scenario=${Buffer.from(JSON.stringify(scenario)).toString('base64')}`, `--profile=${profile}`, `--result=${resultPath}`]
    const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(binary, args, { cwd: __dirname, windowsHide: true, env })
    let outputText = ''
    let timedOut = false
    let spawnError = null
    child.stdout?.on('data', (chunk) => { outputText += chunk })
    child.stderr?.on('data', (chunk) => { outputText += chunk })
    child.once('error', (error) => { spawnError = String(error); outputText += `\n${spawnError}\n` })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 190_000)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      writeFileSync(logPath, outputText)
      let result = null
      if (existsSync(resultPath)) {
        try { result = JSON.parse(readFileSync(resultPath, 'utf8')) } catch (error) { spawnError = `Invalid result JSON: ${error}` }
      }
      const run = {
        caseName, scenario, requestedUrl: cwsUrl, expectedExtensionId, expectedHomepage: expectedHomepage === true, code, signal, timedOut,
        binarySha256: approved.binarySha256, patchsetSha256: approved.patchsetSha256,
        profile, resultPath, logPath, spawnError, result
      }
      run.acceptance = classifyCwsRun(run, approved)
      if (spawnError) { run.acceptance.pass = false; run.acceptance.reasons.push('runner-error') }
      resolveRun(run)
    })
  })
}

async function main() {
  const binary = resolve(option('binary', process.env.VAST_SPIKE_ELECTRON || ''))
  const manifestPath = resolve(option('manifest', join(root, 'patches', 'extension-compatibility-runtime.json')))
  const output = resolve(option('output', join(__dirname, 'results', `cws-native-${new Date().toISOString().replaceAll(':', '-')}`)))
  if (!option('binary', process.env.VAST_SPIKE_ELECTRON)) throw new Error('Pass --binary=<absolute path to patched Electron executable>.')
  if (!isAbsolute(option('binary', process.env.VAST_SPIKE_ELECTRON))) throw new Error('Electron binary path must be absolute.')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.electron?.version !== '44.7.0' || manifest.electron?.chromiumVersion !== '152.0.7977.130') {
    throw new Error('Acceptance requires an approved Electron 44.7.0 / Chromium 152.0.7977.130 manifest.')
  }
  if (!existsSync(binary)) throw new Error(`Binary missing: ${binary}`)
  const binarySha256 = await hashFile(binary)
  const patchsetSha256 = hashPatchset(manifest.electron.patches)
  if (binarySha256 !== manifest.electron.binary?.sha256 || statSync(binary).size !== manifest.electron.binary?.size) {
    throw new Error('Candidate binary does not match the approved manifest hash and size.')
  }
  if (patchsetSha256 !== manifest.electron.patchsetSha256) throw new Error('Patchset does not match the approved manifest.')
  const approved = { binarySha256, patchsetSha256, electron: manifest.electron.version, chrome: manifest.electron.chromiumVersion }
  mkdirSync(output, { recursive: true })
  const allCases = [
    ...Array.from({ length: 10 }, (_, index) => ({ name: `idu-clean-${String(index + 1).padStart(2, '0')}`, url: historicalUrl, id: 'nckhacbgboonmhekihinhokldoogagoh' })),
    { name: 'cws-homepage', url: homepageUrl, homepage: true },
    { name: 'ublock-lite-listing', url: otherUrl, id: 'ddkjiahejlhfcafbddmgiahcphecmpfh' },
    { name: 'ece-mv2-idu', url: historicalUrl, id: 'nckhacbgboonmhekihinhokldoogagoh', mode: 'ece', extension: 'mv2' },
    { name: 'ece-mv3-idu', url: historicalUrl, id: 'nckhacbgboonmhekihinhokldoogagoh', mode: 'ece', extension: 'mv3' },
    { name: 'ece-mv2-ublock-lite', url: otherUrl, id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', mode: 'ece', extension: 'mv2' },
    { name: 'ece-mv3-ublock-lite', url: otherUrl, id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', mode: 'ece', extension: 'mv3' }
  ]
  const requestedCases = option('cases', '').split(',').filter(Boolean)
  const unknownCases = requestedCases.filter((name) => !allCases.some((item) => item.name === name))
  if (unknownCases.length) throw new Error(`Unknown cases: ${unknownCases.join(', ')}`)
  const cases = requestedCases.length ? allCases.filter((item) => requestedCases.includes(item.name)) : allCases
  const summary = { generatedAt: new Date().toISOString(), binary, manifestPath, approved, runs: [] }
  for (const item of cases) {
    process.stdout.write(`[cws] ${item.name} ... `)
    const run = await runCase(binary, output, item, approved)
    summary.runs.push(run)
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(`${run.acceptance.pass ? 'PASS' : 'FAIL'} ${run.acceptance.reasons.join(', ')}`)
  }
  const failures = summary.runs.filter((run) => !run.acceptance.pass)
  console.log(`[cws] ${summary.runs.length - failures.length}/${summary.runs.length} passed; evidence: ${output}`)
  if (failures.length) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
