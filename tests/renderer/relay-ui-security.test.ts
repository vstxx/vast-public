import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const componentPath = new URL('../../src/renderer/components/relay/RelayNoticeOverlay.tsx', import.meta.url)
const richTextPath = new URL('../../src/renderer/components/relay/RelayRichText.tsx', import.meta.url)
const stylePath = new URL('../../src/renderer/components/relay/relay-notice.css', import.meta.url)
const preloadPath = new URL('../../src/preload/index.ts', import.meta.url)
const runtimePath = new URL('../../src/main/relay/runtime.ts', import.meta.url)

test('Relay UI renders passive JSX text and has no remote execution surface', async () => {
  const source = `${await readFile(componentPath, 'utf8')}\n${await readFile(richTextPath, 'utf8')}`
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=|eval\s*\(|new Function|executeJavaScript|shell\./)
  assert.match(source, /\{presentation\.title\}/)
  assert.match(source, /\{presentation\.body\}/)
  assert.match(source, /data-testid="relay-notice"/)
  assert.match(source, /<ModalShell/)
  assert.match(source, /placement="center"/)
  assert.match(source, /<RelayRichText body=\{presentation\.body\}/)
  assert.match(source, /data-testid="relay-rich-text"/)
})

test('Relay renderer IPC is presentation-ID-only and never exposes URL or networking methods', async () => {
  const preload = await readFile(preloadPath, 'utf8')
  const relayBridge = preload.match(/relay:\s*\{[\s\S]*?\r?\n\s*\},\r?\n\s*downloads:/)?.[0] ?? ''
  assert.match(relayBridge, /vast:relay:state/)
  assert.match(relayBridge, /vast:relay:dismiss/)
  assert.match(relayBridge, /vast:relay:action/)
  assert.doesNotMatch(relayBridge, /url|fetch|request|shell|execute/)
})

test('Relay honors reduced motion and keeps the offline hook test-build gated', async () => {
  const [style, runtime] = await Promise.all([readFile(stylePath, 'utf8'), readFile(runtimePath, 'utf8')])
  assert.match(style, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(runtime, /__VAST_INCLUDE_INTERNAL_TEST_HARNESS__\s*&&/)
  assert.match(runtime, /VAST_RELAY_TEST_OFFLINE/)
  assert.doesNotMatch(style, /right:\s*20px|bottom:\s*20px/)
})
