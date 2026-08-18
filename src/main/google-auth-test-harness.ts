import { createInternalGoogleAuthTestWindow } from './sessions'

function testEmailAddress(): string | undefined {
  if (process.env.VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK !== '1') return undefined
  if (!process.env.VAST_TEST_USER_DATA_DIR) return undefined
  const candidate = process.env.VAST_GOOGLE_AUTH_TEST_EMAIL?.trim()
  if (!candidate || candidate.length > 254 || !/^\S+@\S+\.\S+$/.test(candidate)) return undefined
  return candidate
}

function isGoogleIdentifierPage(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.hostname === 'accounts.google.com' && parsed.pathname.endsWith('/signin/identifier')
  } catch {
    return false
  }
}

function sendEmailInput(contents: Electron.WebContents, email: string): void {
  if (contents.isDestroyed()) return
  contents.focus()
  for (const character of email) contents.sendInputEvent({ type: 'char', keyCode: character })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' })
}

export function startInternalGoogleAuthEmailCheck(): boolean {
  const email = testEmailAddress()
  if (!email) return false
  const contents = createInternalGoogleAuthTestWindow()
  let triggered = false
  contents.on('did-finish-load', () => {
    if (triggered || !isGoogleIdentifierPage(contents.getURL())) return
    triggered = true
    setTimeout(() => sendEmailInput(contents, email), 600)
  })
  return true
}
