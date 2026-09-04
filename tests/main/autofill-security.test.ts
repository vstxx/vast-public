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
const captureRuntimeSource = readFileSync(new URL('../../src/preload/credential-capture-runtime.ts', import.meta.url), 'utf8')
const captureCoordinatorSource = readFileSync(new URL('../../src/main/password-capture-coordinator.ts', import.meta.url), 'utf8')
const passwordPromptSource = readFileSync(new URL('../../src/renderer/components/passwords/PasswordSavePrompt.tsx', import.meta.url), 'utf8')
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

test('login capture is opt-in, provisional, main-owned, and prompts in tab-scoped Vast chrome', () => {
  assert.match(guestPreloadSource, /ipcRenderer\.on\('vast:password-capture-config'/)
  assert.match(captureRuntimeSource, /ipcRenderer\.send\('vast:password-capture:attempt'/)
  assert.match(captureRuntimeSource, /ipcRenderer\.send\('vast:password-capture:evidence'/)
  assert.match(ipcSource, /ipcMain\.on\('vast:password-capture:attempt'/)
  assert.match(captureCoordinatorSource, /initialCredentialAssessment/)
  assert.match(captureCoordinatorSource, /SUCCESS_SETTLE_MS/)
  assert.match(captureCoordinatorSource, /ownerWindowId/)
  assert.match(captureRuntimeSource, /sendToHost\('vast:login-form-available'/)
  assert.match(browserRuntimeSource, /message\.channel === 'vast:login-form-available'/)
  assert.doesNotMatch(browserRuntimeSource, /vast:password-login-candidate|candidate\.password/)
  assert.match(passwordIpcSource, /vast:passwords:resolve-save-prompt/)
  assert.match(passwordPromptSource, /password-save-prompt/)
  assert.match(passwordPromptSource, /Never for this site/)
  assert.doesNotMatch(vaultSource, /requestRendererPrompt|pendingCaptureKeys|completed sign-in/)
})

test('plaintext goes directly from main to the isolated guest after ownership and origin revalidation', () => {
  assert.match(vaultSource, /boundAutofillWebContents/)
  assert.match(vaultSource, /owner\?\.id !== mainWindow\.id/)
  assert.match(vaultSource, /The target page navigated before autofill completed/)
  assert.match(vaultSource, /target\.send\('vast:password-autofill-fill'/)
  assert.match(guestPreloadSource, /ipcRenderer\.on\('vast:password-autofill-fill'/)
  assert.match(guestPreloadSource, /pending\.requestId === payload\.requestId/)
  assert.match(guestPreloadSource, /attachShadow\(\{ mode: 'closed' \}\)/)
  assert.doesNotMatch(vaultSource, /executeJavaScript\(directAutofillScript/)
  assert.doesNotMatch(`${ipcSource}\n${passwordIpcSource}`, /credential:\s*await fillAutofillCredentialById/)
  assert.doesNotMatch(browserRuntimeSource, /credential\.password/)
})

test('scoped guest preload exposes no generic IPC, Node, storage, or credential-capture page API', () => {
  assert.doesNotMatch(guestPreloadSource, /ipcRenderer\.invoke\(/)
  assert.deepEqual([...new Set([...captureRuntimeSource.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((match) => match[1]))].sort(), [
    'vast:password-capture:attempt',
    'vast:password-capture:document-state',
    'vast:password-capture:evidence',
    'vast:password-capture:username'
  ])
  assert.doesNotMatch(guestPreloadSource, /exposeInMainWorld/)
  assert.doesNotMatch(`${guestPreloadSource}\n${captureRuntimeSource}`, /from ['"]node:|localStorage|sessionStorage/)
})

test('page scripts cannot synthesize an autofill selection and usernames remain available while locked', () => {
  assert.match(guestPreloadSource, /if \(!event\.isTrusted/)
  assert.match(guestPreloadSource, /randomAutofillRequestId/)
  assert.match(guestPreloadSource, /maybeAutofillUsername/)
  assert.match(ipcSource, /guest\.session\.isPersistent\(\)/)
  assert.doesNotMatch(ipcSource, /getLastWebPreferences\(\).*partition/)
  assert.match(captureRuntimeSource, /if \(!event\.isTrusted/)
  assert.match(captureCoordinatorSource, /blankSecrets/)
  assert.match(captureCoordinatorSource, /owner\.once\('closed'/)
  assert.doesNotMatch(passwordPromptSource, /prompt\.password/)
})

test('capture listeners attach before an immediate login while main remains authoritative', () => {
  assert.match(webviewSource, /settings\.labs\.passwordManager === true/)
  assert.match(webviewSource, /sendToGuest\('vast:password-capture-config', \{ enabled: true \}\)/)
  assert.match(webviewSource, /window\.vast\.passwords\.captureStatus/)
  assert.match(ipcSource, /assertIpcFeatureAllowed\('vast:passwords:capture-status'/)
  assert.match(ipcSource, /passwordCaptureEnabledForOrigin/)
  assert.match(webviewSource, /if \(isPrivate \|\| !origin \|\| !locallyEnabled\)/)
  assert.match(captureRuntimeSource, /if \(!enabled\) return/)
  assert.match(captureRuntimeSource, /observer\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/)
  assert.doesNotMatch(captureRuntimeSource, /setInterval\(/)
})

test('credential commits are prompt-bound, serialized and reject lifecycle races', () => {
  assert.match(captureCoordinatorSource, /preparedRecordId/)
  assert.match(captureCoordinatorSource, /attempt\.prompt\.action/)
  assert.match(captureCoordinatorSource, /This password decision is already being applied/)
  assert.match(captureCoordinatorSource, /this\.attempts\.get\(attemptId\) !== attempt/)
  assert.match(vaultSource, /expectedAction === 'update'/)
  assert.match(vaultSource, /plan\.recordId !== expectedRecordId/)
  assert.match(vaultSource, /credentialMutationChain/)
})
