import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { guestDocumentStartResponse, type GuestDocumentStartDependencies } from '../../src/main/guest-document-start.ts'

type Contents = { id: number }
type Frame = { main: boolean }
const contents: Contents = { id: 7 }
const mainFrame: Frame = { main: true }
const spoofing = { userAgent: 'UA' } as never

function deps(overrides: Partial<GuestDocumentStartDependencies<Contents, Frame>> = {}, calls: string[] = []): GuestDocumentStartDependencies<Contents, Frame> {
  return {
    trustedHost: () => { calls.push('trust'); return true },
    spoofingConfig: () => { calls.push('spoofing'); return spoofing },
    privacyScript: () => { calls.push('privacy'); return '/* privacy */' },
    undecidedPermissions: () => { calls.push('permissions'); return ['camera', 'microphone'] },
    documentRulesAllowed: () => { calls.push('allowed'); return true },
    takeDocumentRules: (_c, _u, frame) => { calls.push('take'); return frame.main ? ['rule-a', 'rule-b'] : [] },
    ...overrides
  }
}

test('one reply carries spoofing, privacy and document rules, computed in the original order', () => {
  const calls: string[] = []
  const reply = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: true }, deps({}, calls))
  assert.deepEqual(reply, { spoofing, privacyScript: '/* privacy */', undecidedPermissions: ['camera', 'microphone'], documentRules: ['rule-a', 'rule-b'] })
  assert.deepEqual(calls, ['trust', 'spoofing', 'privacy', 'permissions', 'allowed', 'take'])
})

test('document rules are neither checked nor consumed unless the preload asks for them', () => {
  const calls: string[] = []
  const reply = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: false }, deps({}, calls))
  assert.deepEqual(reply.documentRules, [])
  assert.ok(!calls.includes('allowed') && !calls.includes('take'), 'staged rules stay available for the main frame')
})

test('an untrusted host gets no spoofing or privacy script, as before', () => {
  const calls: string[] = []
  const reply = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: true }, deps({ trustedHost: () => false }, calls))
  assert.equal(reply.spoofing, null)
  assert.equal(reply.privacyScript, '')
  assert.ok(!calls.includes('spoofing') && !calls.includes('privacy'))
  // Document rules keep their own authorization (owner window, interventions, frame and URL match).
  assert.deepEqual(reply.documentRules, ['rule-a', 'rule-b'])
})

test('document rules respect their own authorization', () => {
  const reply = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: true }, deps({ documentRulesAllowed: () => false }))
  assert.deepEqual(reply.documentRules, [])
})

test('malformed and oversized requests get the empty reply', () => {
  const empty = { spoofing: null, privacyScript: '', undecidedPermissions: [], documentRules: [] }
  for (const request of [undefined, null, 'https://example.com/', { url: 42, documentRules: true }, {}]) {
    assert.deepEqual(guestDocumentStartResponse(contents, mainFrame, request, deps()), empty)
  }
  const long = guestDocumentStartResponse(contents, mainFrame, { url: `https://example.com/${'a'.repeat(40_000)}`, documentRules: false }, deps())
  assert.deepEqual(long, empty)
})

test('a failure in one part never blocks the others or the navigation', () => {
  const reply = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: true }, deps({
    spoofingConfig: () => { throw new Error('spoofing unavailable') },
    takeDocumentRules: () => { throw new Error('rules unavailable') }
  }))
  assert.deepEqual(reply, { spoofing: null, privacyScript: '/* privacy */', undecidedPermissions: ['camera', 'microphone'], documentRules: [] })
  const noTrust = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: false }, deps({ trustedHost: () => { throw new Error('host gone') } }))
  assert.deepEqual(noTrust, { spoofing: null, privacyScript: '', undecidedPermissions: [], documentRules: [] })
})

test('only well-typed rules are returned', () => {
  const reply = guestDocumentStartResponse(contents, mainFrame, { url: 'https://example.com/', documentRules: true }, deps({ takeDocumentRules: () => ['ok', 5, null] as never }))
  assert.deepEqual(reply.documentRules, ['ok'])
})

test('the guest preload makes exactly one synchronous request and the old channels are gone', () => {
  const guest = readFileSync(new URL('../../src/preload/guest.ts', import.meta.url), 'utf8')
  const ipc = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
  assert.equal(guest.match(/sendSync\(/g)?.length, 1)
  assert.match(guest, /documentRules: process\.isMainFrame && \/\^https\?:\$\/\.test\(location\.protocol\)/)
  // Application order is unchanged: spoofing in the main world, then privacy, then extension rules.
  const order = ['executeInMainWorld', 'documentStart.privacyScript', 'documentStart.documentRules'].map((needle) => guest.indexOf(needle))
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2])
  for (const channel of ['vast:spoofing:document-config', 'vast:privacy:document-script', 'vast:extensions:document-rules']) {
    assert.ok(!guest.includes(channel) && !ipc.includes(channel), `${channel} should be retired`)
  }
  assert.match(ipc, /ipcMain\.on\(GUEST_DOCUMENT_START_CHANNEL/)
})
