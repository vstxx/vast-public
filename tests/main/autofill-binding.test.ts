import assert from 'node:assert/strict'
import test from 'node:test'

import { autofillRequestMatchesWebContents } from '../../src/main/autofill-binding.ts'

test('autofill binding requires exact origin and webContents id', () => {
  assert.equal(
    autofillRequestMatchesWebContents({ requestedOrigin: 'https://example.com', requestedWebContentsId: 7 }, { id: 7, url: 'https://example.com/login' }),
    true
  )
  assert.equal(
    autofillRequestMatchesWebContents({ requestedOrigin: 'https://example.com', requestedWebContentsId: 7 }, { id: 8, url: 'https://example.com/login' }),
    false
  )
  assert.equal(
    autofillRequestMatchesWebContents({ requestedOrigin: 'https://example.com', requestedWebContentsId: 7 }, { id: 7, url: 'https://evil.example/login' }),
    false
  )
})
