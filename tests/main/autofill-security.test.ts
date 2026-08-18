import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const vaultSource = readFileSync(new URL('../../src/main/password-vault.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const passwordIpcSource = readFileSync(new URL('../../src/main/ipc/passwords.ts', import.meta.url), 'utf8')
const stageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const browserRuntimeSource = `${stageSource}\n${webviewSource}`
const guestPreloadSource = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')
const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')

test('autofill selection is event-driven through a narrowly scoped guest preload', () => {
  assert.match(guestPreloadSource, /sendToHost\('vast:autofill-select'/)
  assert.match(browserRuntimeSource, /addEventListener\('ipc-message', onGuestIpcMessage\)/)
  assert.match(browserRuntimeSource, /sendToGuest\('vast:password-autofill-config'/)
  assert.doesNotMatch(browserRuntimeSource, /buildAutofillScript|buildLoginDetectionScript/)
  assert.doesNotMatch(browserRuntimeSource, /__vastAutofillRequest/)
  assert.doesNotMatch(browserRuntimeSource, /750/)
  assert.match(sessionsSource, /webPreferences\.preload = join\(__dirname, '\.\.\/preload\/guest-autofill\.js'\)/)
})

test('login capture is opt-in per document and prompts in trusted Vast chrome', () => {
  assert.match(guestPreloadSource, /ipcRenderer\.on\('vast:password-capture-config'/)
  assert.match(guestPreloadSource, /sendToHost\('vast:password-login-candidate'/)
  assert.match(guestPreloadSource, /MutationObserver\(scheduleLoginFormSignal\)/)
  assert.match(guestPreloadSource, /sendToHost\('vast:login-form-available'/)
  assert.match(guestPreloadSource, /MAX_LOGIN_FORM_SCAN_ATTEMPTS = 6/)
  assert.match(guestPreloadSource, /if \(loginFormScanAttempts < MAX_LOGIN_FORM_SCAN_ATTEMPTS\) queueLoginFormScan\(\)/)
  assert.match(browserRuntimeSource, /automaticPasswordCaptureOrigin/)
  assert.match(browserRuntimeSource, /message\.channel === 'vast:login-form-available'/)
  assert.match(passwordIpcSource, /vast:passwords:capture-login/)
  assert.match(vaultSource, /requestRendererPrompt/)
  assert.match(vaultSource, /Never for this site/)
  assert.match(vaultSource, /pendingCaptureKeys/)
})

test('plaintext is decrypted and injected only by main after ownership and origin revalidation', () => {
  assert.match(vaultSource, /boundAutofillWebContents/)
  assert.match(vaultSource, /owner\?\.id !== mainWindow\.id/)
  assert.match(vaultSource, /The target page navigated before autofill completed/)
  assert.match(vaultSource, /await target\.executeJavaScript\(directAutofillScript/)
  assert.doesNotMatch(`${ipcSource}\n${passwordIpcSource}`, /credential:\s*await fillAutofillCredentialById/)
  assert.doesNotMatch(browserRuntimeSource, /credential\.password/)
})

test('scoped guest preload exposes no generic IPC, Node, storage, or credential-capture page API', () => {
  assert.doesNotMatch(guestPreloadSource, /ipcRenderer\.(invoke|send)\(/)
  assert.doesNotMatch(guestPreloadSource, /contextBridge|exposeInMainWorld/)
  assert.doesNotMatch(guestPreloadSource, /from ['"]node:|localStorage|sessionStorage/)
})
