import assert from 'node:assert/strict'
import test from 'node:test'

import { isLikelyCallUrl } from '../../src/shared/call-protection.ts'

test('call protection recognizes major conferencing surfaces and generic call subdomains', () => {
  for (const url of [
    'https://meet.google.com/abc-defg-hij',
    'https://company.zoom.us/j/123',
    'https://teams.microsoft.com/v2/',
    'https://company.webex.com/meet/person',
    'https://meet.jit.si/VastRoom',
    'https://discord.com/channels/1/2',
    'https://web.whatsapp.com/',
    'https://call.example.org/room/42',
    'https://conference.example.org/session'
  ]) {
    assert.equal(isLikelyCallUrl(url), true, url)
  }
})

test('ordinary pages and restored internal tabs are not classified as calls', () => {
  for (const url of [
    'https://example.com/',
    'https://example.com/blog/video-editing',
    'https://google.com/search?q=meet',
    'vast://newtab',
    'not a url'
  ]) {
    assert.equal(isLikelyCallUrl(url), false, url)
  }
})
