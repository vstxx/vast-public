import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { classifyCwsRun } = require('../../experiments/extension-compatibility-spike/cws-acceptance-policy.cjs')
const approved = { binarySha256: 'a'.repeat(64), patchsetSha256: 'b'.repeat(64), electron: '44.7.0', chrome: '152.0.7977.130' }

function successfulRun() {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    binarySha256: approved.binarySha256,
    patchsetSha256: approved.patchsetSha256,
    expectedExtensionId: 'nckhacbgboonmhekihinhokldoogagoh',
    result: {
      completed: true,
      versions: { electron: approved.electron, chrome: approved.chrome },
      errors: [],
      crashDumpFiles: [],
      rendererProcessGone: false,
      cws: {
        finalUrl: 'https://chromewebstore.google.com/detail/idu+/nckhacbgboonmhekihinhokldoogagoh?hl=pl',
        pageLoaded: true,
        stableForMs: 60_000
      }
    }
  }
}

test('accepts only a committed CWS page that survived for 60 seconds', () => {
  assert.deepEqual(classifyCwsRun(successfulRun(), approved), { pass: true, reasons: [] })
})

test('consent or unrelated pages never count as a CWS load', () => {
  for (const finalUrl of [
    'https://consent.google.com/m',
    'vast://unsupported-extension-store',
    'https://chromewebstore.google.com.evil.test/',
    'https://chromewebstore.google.com/detail/nckhacbgboonmhekihinhokldoogagoh/error'
  ]) {
    const run = successfulRun()
    run.result.cws.finalUrl = finalUrl
    assert.equal(classifyCwsRun(run, approved).pass, false, finalUrl)
  }
})

test('a different store listing cannot satisfy the requested extension', () => {
  const run = successfulRun()
  run.result.cws.finalUrl = 'https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm'
  assert.deepEqual(classifyCwsRun(run, approved).reasons, ['wrong-extension-page'])
})

test('the homepage case requires the actual homepage', () => {
  const run = successfulRun()
  run.expectedExtensionId = ''
  run.expectedHomepage = true
  assert.deepEqual(classifyCwsRun(run, approved).reasons, ['wrong-homepage'])
  run.result.cws.finalUrl = 'https://chromewebstore.google.com/'
  assert.equal(classifyCwsRun(run, approved).pass, true)
})

test('failed load, early exit, renderer loss, dump, and short dwell fail independently', () => {
  const mutations = [
    (run: ReturnType<typeof successfulRun>) => { run.result.cws.pageLoaded = false },
    (run: ReturnType<typeof successfulRun>) => { run.code = 0xc0000005 },
    (run: ReturnType<typeof successfulRun>) => { run.timedOut = true },
    (run: ReturnType<typeof successfulRun>) => { run.result.rendererProcessGone = true },
    (run: ReturnType<typeof successfulRun>) => { run.result.crashDumpFiles = ['crash.dmp'] },
    (run: ReturnType<typeof successfulRun>) => { run.result.cws.stableForMs = 59_999 }
  ]
  for (const mutate of mutations) {
    const run = successfulRun()
    mutate(run)
    assert.equal(classifyCwsRun(run, approved).pass, false)
  }
})

test('a version string cannot authorize a different executable or patchset', () => {
  const wrongBinary = successfulRun()
  wrongBinary.binarySha256 = 'c'.repeat(64)
  assert.equal(classifyCwsRun(wrongBinary, approved).pass, false)
  const wrongPatchset = successfulRun()
  wrongPatchset.patchsetSha256 = 'd'.repeat(64)
  assert.equal(classifyCwsRun(wrongPatchset, approved).pass, false)
})

test('a CWS pass with a requested extension requires that extension to have loaded', () => {
  const run = { ...successfulRun(), scenario: { extension: 'mv3' } }
  assert.deepEqual(classifyCwsRun(run, approved).reasons, ['extension-not-loaded'])
  assert.equal(classifyCwsRun({ ...run, result: { ...run.result, extension: { id: 'a'.repeat(32) } } }, approved).pass, true)
})
