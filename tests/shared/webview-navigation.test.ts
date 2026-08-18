import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GuestNavigationUrlQueue,
  shouldAcceptWebviewNavigationEvent,
  webviewNavigationUrl
} from '../../src/shared/webview-navigation.ts'

const gmailInbox = 'https://mail.google.com/mail/u/0/#inbox'
const gmailHovercard =
  'https://contacts.google.com/widget/hovercard/v/2?hl=pl&origin=https%3A%2F%2Fmail.google.com#id=I__HC_94253229'

test('webview navigation ignores explicit iframe navigation events', () => {
  assert.equal(
    shouldAcceptWebviewNavigationEvent({ url: gmailHovercard, isMainFrame: false }, gmailInbox),
    false
  )
})

test('webview navigation ignores iframe-like URL mismatches without a main-frame flag', () => {
  assert.equal(
    shouldAcceptWebviewNavigationEvent({ url: gmailHovercard }, gmailInbox),
    false
  )
})

test('webview navigation accepts main-frame in-page URL changes', () => {
  const nextGmailUrl = 'https://mail.google.com/mail/u/0/#sent'
  assert.equal(
    shouldAcceptWebviewNavigationEvent({ url: nextGmailUrl, isMainFrame: true }, gmailInbox),
    true
  )
  assert.equal(webviewNavigationUrl({ url: nextGmailUrl, isMainFrame: true }, gmailInbox), nextGmailUrl)
})

test('webview navigation accepts matching top-level navigation events without a main-frame flag', () => {
  assert.equal(
    shouldAcceptWebviewNavigationEvent({ url: gmailInbox }, gmailInbox),
    true
  )
})

test('webview navigation falls back to the current webview URL when the event has no URL', () => {
  assert.equal(webviewNavigationUrl({}, gmailInbox), gmailInbox)
})

test('guest navigation URL queue consumes delayed SPA updates without replaying them', () => {
  const queue = new GuestNavigationUrlQueue()
  const marriottBase = 'https://www.marriott.com/search/availabilityCalendar.mi?costTab=total'
  const guestUrls = Array.from({ length: 37 }, (_, index) => `${marriottBase}#/${31 + index}/`)

  for (const url of guestUrls) queue.remember(url)

  // React may skip intermediate renders and receive an older guest URL after
  // the page has already advanced. Both remain guest-originated updates.
  assert.equal(queue.consume(guestUrls[8]), true)
  assert.equal(queue.consume(guestUrls.at(-1)!), true)

  // Once the guest updates are drained, the same URL is an explicit external
  // request (for example from the address bar) and must be loaded normally.
  assert.equal(queue.consume(guestUrls[8]), false)
})

test('guest navigation URL queue clears stale provenance on an external URL', () => {
  const queue = new GuestNavigationUrlQueue()
  queue.remember('https://example.com/#/one')
  queue.remember('https://example.com/#/two')

  assert.equal(queue.consume('https://example.net/explicit'), false)
  assert.equal(queue.consume('https://example.com/#/two'), false)
})
