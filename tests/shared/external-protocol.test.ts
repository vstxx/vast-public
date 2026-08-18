import assert from 'node:assert/strict'
import test from 'node:test'

import { externalProtocolTarget } from '../../src/shared/external-protocol.ts'

test('external app protocol policy accepts app links without accepting web or privileged schemes', () => {
  assert.deepEqual(externalProtocolTarget('zoommtg://zoom.us/join?confno=123'), {
    url: 'zoommtg://zoom.us/join?confno=123',
    scheme: 'zoommtg:'
  })
  assert.deepEqual(externalProtocolTarget('spotify:track:abc'), {
    url: 'spotify:track:abc',
    scheme: 'spotify:'
  })
  assert.equal(externalProtocolTarget('mailto:hello@example.com')?.scheme, 'mailto:')

  for (const url of [
    'https://example.com',
    'http://example.com',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'data:text/html,hello',
    'blob:https://example.com/id',
    'chrome://version',
    'devtools://devtools/bundled',
    'vast://newtab',
    'not a url'
  ]) {
    assert.equal(externalProtocolTarget(url), undefined, url)
  }
})

test('external app protocol policy bounds untrusted navigation payloads', () => {
  assert.equal(externalProtocolTarget(`spotify:${'x'.repeat(33 * 1024)}`), undefined)
  assert.equal(externalProtocolTarget('1invalid://target'), undefined)
  assert.equal(externalProtocolTarget('a://target'), undefined)
})
