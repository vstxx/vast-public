import type { PasswordSavePromptAction, PasswordVaultInput, PasswordVaultUpdate } from '../../shared/types'
import { passwordCaptureCoordinator } from '../password-capture-coordinator'
import {
  assertNonEmptyString,
  assertObject,
  assertPositiveInteger,
  fail,
  ok,
  type IpcHandle,
  type SenderWindowFor
} from './registration'

interface PasswordSessionControls {
  status: () => unknown
  lock: () => unknown
  unlock: () => unknown
}

function assertOrigin(origin: unknown): asserts origin is string {
  assertNonEmptyString(origin, 'origin', 4096)
}

function assertCredentialId(id: unknown): asserts id is string {
  assertNonEmptyString(id, 'credential id', 256)
}

function assertAutofillRequestId(requestId: unknown): asserts requestId is string {
  assertNonEmptyString(requestId, 'autofill request id', 128)
  if (!/^[a-f0-9]{32}$/i.test(requestId)) throw new Error('Invalid autofill request id.')
}

export function registerPasswordIpc(
  handle: IpcHandle,
  senderWindowFor: SenderWindowFor,
  session: PasswordSessionControls
): void {
  handle('vast:passwords:session-status', async () => ({ ok: true, state: session.status() }))
  handle('vast:passwords:lock-session', async () => ({ ok: true, state: session.lock() }))

  handle('vast:passwords:list', async () => {
    try {
      return { ok: true, ...(await (await import('../password-vault')).listPasswordVaultItems()) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:create', async (_event, input: PasswordVaultInput) => {
    try {
      assertObject(input, 'password item')
      return { ok: true, item: await (await import('../password-vault')).createPasswordVaultItem(input) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:update', async (_event, id: string, input: PasswordVaultUpdate) => {
    try {
      assertCredentialId(id)
      assertObject(input, 'password update')
      return { ok: true, item: await (await import('../password-vault')).updatePasswordVaultItem(id, input) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:remove', async (_event, id: string) => {
    try {
      assertCredentialId(id)
      await (await import('../password-vault')).deletePasswordVaultItem(id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:copy-username', async (_event, id: string) => {
    try {
      assertCredentialId(id)
      await (await import('../password-vault')).copyPasswordUsername(id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:copy-password', async (event, id: string) => {
    try {
      assertCredentialId(id)
      const owner = senderWindowFor(event)
      await (await import('../password-vault')).copyPasswordSecretWithConfirmation(owner, id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:autofill', async (event, webContentsId: number, origin: string) => {
    try {
      assertPositiveInteger(webContentsId, 'webContents id')
      assertOrigin(origin)
      const owner = senderWindowFor(event)
      return { ok: true, filled: await (await import('../password-vault')).fillBestAutofillCredential(owner, webContentsId, origin, () => session.unlock()) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:autofill-suggestions', async (event, webContentsId: number, origin: string) => {
    try {
      assertPositiveInteger(webContentsId, 'webContents id')
      assertOrigin(origin)
      const owner = senderWindowFor(event)
      return { ok: true, suggestions: await (await import('../password-vault')).getAutofillSuggestionsForOrigin(owner, webContentsId, origin) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:fill-by-id', async (event, id: string, webContentsId: number, origin: string, requestId: string) => {
    try {
      assertCredentialId(id)
      assertPositiveInteger(webContentsId, 'webContents id')
      assertOrigin(origin)
      assertAutofillRequestId(requestId)
      const owner = senderWindowFor(event)
      const [{ loadData }, vault] = await Promise.all([import('../storage'), import('../password-vault')])
      const data = await loadData()
      return {
        ok: true,
        filled: await vault.fillAutofillCredentialById(
          owner,
          id,
          webContentsId,
          origin,
          requestId,
          data.settings.security.alwaysConfirmAutofill,
          () => session.unlock()
        )
      }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:save-captured', async (_event, input: PasswordVaultInput) => {
    try {
      assertObject(input, 'captured login')
      return { ok: true, item: await (await import('../password-vault')).saveCapturedLogin(input) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:capture-status', async (event, webContentsId: number, origin: string) => {
    try {
      assertPositiveInteger(webContentsId, 'webContents id')
      assertOrigin(origin)
      const owner = senderWindowFor(event)
      return { ok: true, enabled: await (await import('../password-vault')).passwordCaptureEnabledForOrigin(owner, webContentsId, origin) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:resolve-save-prompt', async (event, attemptId: string, action: PasswordSavePromptAction) => {
    try {
      assertNonEmptyString(attemptId, 'credential attempt id', 64)
      if (action !== 'save' && action !== 'update' && action !== 'not-now' && action !== 'never') {
        throw new Error('Invalid password prompt action.')
      }
      return { ok: true, outcome: await passwordCaptureCoordinator.resolvePrompt(senderWindowFor(event), attemptId, action) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:allow-save-prompts', async (_event, origin: string) => {
    try {
      assertOrigin(origin)
      await (await import('../password-vault')).allowPasswordSavePrompts(origin)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:import-csv', async (event) => {
    try {
      const owner = senderWindowFor(event)
      return { ok: true, ...(await (await import('../password-vault')).importPasswordsCsv(owner)) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:export-csv', async (event) => {
    try {
      const owner = senderWindowFor(event)
      return { ok: true, ...(await (await import('../password-vault')).exportPasswordsCsv(owner)) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:audit', async () => {
    try {
      return { ok: true, audit: await (await import('../password-vault')).auditPasswordVault() }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:passwords:unlock-session', async (event) => {
    try {
      const owner = senderWindowFor(event)
      await (await import('../password-vault')).confirmVaultUnlock(owner)
      return { ok: true, state: session.unlock() }
    } catch (error) {
      return fail(error)
    }
  })
}
