import { clipboard } from 'electron/common'
import { app, BrowserWindow, dialog, safeStorage, webContents } from 'electron/main'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  ID,
  PasswordCaptureOutcome,
  PasswordVaultInput,
  PasswordVaultAudit,
  PasswordVaultItem,
  PasswordVaultUpdate
} from '../shared/types'
import type { PasswordLoginCandidate } from '../shared/password-capture-policy'
import { automaticPasswordCaptureOrigin, classifyPasswordCapture, normalizedCredentialUsername, sanitizePasswordLoginCandidate } from '../shared/password-capture-policy'
import { parsePasswordImportCsv, passwordCsvCell } from '../shared/password-csv'
import { autofillRequestMatchesWebContents } from './autofill-binding'
import { dataFilePath } from './data-path'
import { requestRendererPrompt, showRendererNotification } from './ui-bridge'
import { vaultStorageBackendIsSecure } from './password-vault-crypto-policy'

interface EncryptedPasswordRecord extends Omit<PasswordVaultItem, 'username' | 'notes'> {
  encryptedPassword: string
  encryptedUsername: string
  encryptedNotes?: string
}

interface VaultFile {
  schemaVersion: 2
  records: EncryptedPasswordRecord[]
  savePromptNeverOrigins: string[]
}

const vaultFileName = 'password-vault.json'
const maxPasswordCsvBytes = 2 * 1024 * 1024
const maxPasswordCsvRows = 1000
let cachedVault: VaultFile | null = null
let saveChain: Promise<void> = Promise.resolve()
const pendingCaptureKeys = new Set<string>()

function vaultPath(): string {
  return dataFilePath(vaultFileName)
}

function emptyVault(): VaultFile {
  return { schemaVersion: 2, records: [], savePromptNeverOrigins: [] }
}

function publicItem(record: EncryptedPasswordRecord): PasswordVaultItem {
  const {
    encryptedPassword: _encryptedPassword,
    encryptedUsername: _encryptedUsername,
    encryptedNotes: _encryptedNotes,
    ...item
  } = record
  return {
    ...item,
    username: decryptVaultField(record.encryptedUsername, 'username'),
    notes: record.encryptedNotes === undefined ? undefined : decryptVaultField(record.encryptedNotes, 'notes')
  }
}

let warnedAboutBasicText = false

function selectedStorageBackend(): string | undefined {
  return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined
}

function secureEncryptionAvailable(): boolean {
  return vaultStorageBackendIsSecure(process.platform, safeStorage.isEncryptionAvailable(), selectedStorageBackend())
}

function ensureEncryptionAvailable(): void {
  const backend = selectedStorageBackend()
  if (process.platform === 'linux' && backend === 'basic_text') {
    if (!warnedAboutBasicText) {
      console.warn('[password-vault] Refusing to use Electron safeStorage with the insecure Linux basic_text backend.')
      warnedAboutBasicText = true
    }
    throw new Error('Password Manager requires a Linux secret store. The current safeStorage backend is basic_text and is not secure.')
  }
  if (!vaultStorageBackendIsSecure(process.platform, safeStorage.isEncryptionAvailable(), backend)) {
    throw new Error('OS password encryption is not available on this machine.')
  }
}

function encryptVaultField(value: string): string {
  ensureEncryptionAvailable()
  return safeStorage.encryptString(value).toString('base64')
}

function decryptVaultField(value: string, field: 'password' | 'username' | 'notes'): string {
  ensureEncryptionAvailable()
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    throw new Error(`Could not decrypt this saved ${field}. The password vault key does not match this profile. Restore the matching Local State file or re-import the password.`)
  }
}

function decryptPassword(record: EncryptedPasswordRecord): string {
  return decryptVaultField(record.encryptedPassword, 'password')
}

function decryptUsername(record: EncryptedPasswordRecord): string {
  return decryptVaultField(record.encryptedUsername, 'username')
}

function decryptNotes(record: EncryptedPasswordRecord): string | undefined {
  return record.encryptedNotes === undefined ? undefined : decryptVaultField(record.encryptedNotes, 'notes')
}

function normalizeOrigin(input: string): { origin: string; hostname: string } {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 2048) throw new Error('Invalid origin.')
  const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Passwords can only be saved for http(s) origins.')
  }
  return {
    origin: parsed.origin,
    hostname: parsed.hostname.replace(/^www\./, '')
  }
}

function validText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Invalid password vault payload.')
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error('Password vault field is too long.')
  return trimmed
}

function validateInput(input: PasswordVaultInput): {
  origin: string
  hostname: string
  username: string
  password: string
  title: string
  notes?: string
  favicon?: string
  autofillPolicy: 'ask' | 'never'
} {
  if (!input || typeof input !== 'object') throw new Error('Invalid password vault payload.')
  const { origin, hostname } = normalizeOrigin(input.origin)
  if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 4096) {
    throw new Error('Password must be between 1 and 4096 characters.')
  }
  const username = validText(input.username, 512) ?? ''
  const title = validText(input.title, 256) || hostname
  const notes = validText(input.notes, 2000)
  const favicon = validText(input.favicon, 2048)
  const autofillPolicy = input.autofillPolicy === 'never' ? 'never' : 'ask'
  return { origin, hostname, username, password: input.password, title, notes, favicon, autofillPolicy }
}

function normalizeStoredRecord(value: unknown): { record: EncryptedPasswordRecord; migrated: boolean } | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  if (typeof source.id !== 'string' || typeof source.encryptedPassword !== 'string') return null

  const legacyUsername = typeof source.username === 'string' ? source.username : ''
  const legacyNotes = typeof source.notes === 'string' ? source.notes : undefined
  const encryptedUsername = typeof source.encryptedUsername === 'string'
    ? source.encryptedUsername
    : encryptVaultField(legacyUsername)
  const encryptedNotes = typeof source.encryptedNotes === 'string'
    ? source.encryptedNotes
    : legacyNotes === undefined ? undefined : encryptVaultField(legacyNotes)

  return {
    migrated: typeof source.encryptedUsername !== 'string' || 'username' in source || 'notes' in source,
    record: {
      id: source.id,
      origin: typeof source.origin === 'string' ? source.origin : '',
      hostname: typeof source.hostname === 'string' ? source.hostname : '',
      title: typeof source.title === 'string' ? source.title : '',
      createdAt: typeof source.createdAt === 'number' ? source.createdAt : 0,
      updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0,
      lastUsedAt: typeof source.lastUsedAt === 'number' ? source.lastUsedAt : undefined,
      favicon: typeof source.favicon === 'string' ? source.favicon : undefined,
      autofillPolicy: source.autofillPolicy === 'never' ? 'never' : 'ask',
      encryptedPassword: source.encryptedPassword,
      encryptedUsername,
      encryptedNotes
    }
  }
}

async function loadVault(): Promise<VaultFile> {
  if (cachedVault) return cachedVault
  ensureEncryptionAvailable()
  let raw: string
  try {
    raw = await readFile(vaultPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    cachedVault = emptyVault()
    await saveVault(cachedVault)
    return cachedVault
  }

  let parsed: { schemaVersion?: unknown; records?: unknown; savePromptNeverOrigins?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
    if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !Array.isArray(parsed.records)) {
      throw new Error('Invalid password vault schema.')
    }
  } catch (error) {
    console.warn('[password-vault] Falling back to an empty vault:', error)
    await backupRejectedVaultFile()
    cachedVault = emptyVault()
    await saveVault(cachedVault)
    return cachedVault
  }

  const migrationRequired = parsed.schemaVersion !== 2 || parsed.records.some((value) => {
    if (!value || typeof value !== 'object') return false
    const source = value as Record<string, unknown>
    return typeof source.encryptedPassword === 'string' && typeof source.encryptedUsername !== 'string'
  })
  if (migrationRequired) {
    // Migration encrypts legacy plaintext metadata with the active profile key.
    // Prove that the same key can read every existing secret first, otherwise
    // saving would create a mixed-key vault and make recovery harder.
    for (const value of parsed.records) {
      if (!value || typeof value !== 'object') continue
      const encryptedPassword = (value as Record<string, unknown>).encryptedPassword
      if (typeof encryptedPassword === 'string') decryptVaultField(encryptedPassword, 'password')
    }
  }

  const normalizedRecords = parsed.records.map(normalizeStoredRecord).filter((result): result is NonNullable<typeof result> => Boolean(result))
  const nextVault: VaultFile = {
    schemaVersion: 2,
    records: normalizedRecords.map(({ record }) => record),
    savePromptNeverOrigins: Array.isArray(parsed.savePromptNeverOrigins)
      ? parsed.savePromptNeverOrigins.filter((origin): origin is string => typeof origin === 'string' && Boolean(automaticPasswordCaptureOrigin(origin))).slice(0, 500)
      : []
  }
  if (parsed.schemaVersion !== 2 || normalizedRecords.some(({ migrated }) => migrated)) await saveVault(nextVault)
  else cachedVault = nextVault
  return nextVault
}

async function backupRejectedVaultFile(): Promise<void> {
  try {
    await copyFile(vaultPath(), `${vaultPath()}.invalid-${Date.now()}.bak`)
  } catch (backupError) {
    console.warn('[password-vault] Could not back up rejected vault file:', backupError)
  }
}

async function writeVault(vault: VaultFile): Promise<void> {
  const file = vaultPath()
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, `${JSON.stringify(vault, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  cachedVault = vault
}

async function saveVault(vault: VaultFile): Promise<void> {
  const nextSave = saveChain.then(() => writeVault(vault))
  saveChain = nextSave.catch(() => undefined)
  await nextSave
}

export async function listPasswordVaultItems(): Promise<{ items: PasswordVaultItem[]; encryptionAvailable: boolean; suppressedOrigins: string[] }> {
  if (!secureEncryptionAvailable()) {
    ensureEncryptionAvailable()
  }
  const vault = await loadVault()
  return {
    encryptionAvailable: true,
    suppressedOrigins: [...vault.savePromptNeverOrigins].sort(),
    items: vault.records
      .map(publicItem)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  }
}

export async function auditPasswordVault(): Promise<PasswordVaultAudit> {
  ensureEncryptionAvailable()
  const vault = await loadVault()
  const weakIds: ID[] = []
  const hashGroups = new Map<string, ID[]>()
  const duplicateGroups = new Map<string, ID[]>()
  for (const record of vault.records) {
    const password = decryptPassword(record)
    const classes = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length
    if (password.length < 12 || classes < 3) weakIds.push(record.id)
    const hash = createHash('sha256').update(password, 'utf8').digest('hex')
    hashGroups.set(hash, [...(hashGroups.get(hash) ?? []), record.id])
    const duplicateKey = `${record.origin}\u0000${decryptUsername(record).toLocaleLowerCase()}`
    duplicateGroups.set(duplicateKey, [...(duplicateGroups.get(duplicateKey) ?? []), record.id])
  }
  return {
    weakIds,
    reusedGroups: [...hashGroups.values()].filter((ids) => ids.length > 1),
    duplicateIds: [...new Set([...duplicateGroups.values()].filter((ids) => ids.length > 1).flat())]
  }
}

export async function confirmVaultUnlock(mainWindow: BrowserWindow): Promise<void> {
  ensureEncryptionAvailable()
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Unlock Password Manager',
    message: 'Unlock Password Manager for this Vast session?',
    detail: process.platform === 'win32'
      ? 'The session locks after 5 minutes of vault inactivity, 15 minutes total, Windows lock, or suspend. Sensitive actions require an unlock from the last 2 minutes; password reveal and plaintext export still require separate native confirmations.'
      : 'The session locks after 5 minutes of vault inactivity, 15 minutes total, screen lock, or suspend. Sensitive actions require an unlock from the last 2 minutes; password reveal and plaintext export still require separate native confirmations.',
    buttons: ['Unlock session', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (result.response !== 0) throw new Error('Vault unlock cancelled.')
}

export async function createPasswordVaultItem(input: PasswordVaultInput): Promise<PasswordVaultItem> {
  const normalized = validateInput(input)
  const vault = await loadVault()
  const now = Date.now()
  const record: EncryptedPasswordRecord = {
    id: randomUUID(),
    origin: normalized.origin,
    hostname: normalized.hostname,
    encryptedUsername: encryptVaultField(normalized.username),
    encryptedPassword: encryptVaultField(normalized.password),
    title: normalized.title,
    createdAt: now,
    updatedAt: now,
    encryptedNotes: normalized.notes === undefined ? undefined : encryptVaultField(normalized.notes),
    favicon: normalized.favicon,
    autofillPolicy: normalized.autofillPolicy
  }
  await saveVault({ ...vault, records: [record, ...vault.records] })
  return publicItem(record)
}

export async function updatePasswordVaultItem(id: ID, input: PasswordVaultUpdate): Promise<PasswordVaultItem> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid password id.')
  const vault = await loadVault()
  const index = vault.records.findIndex((record) => record.id === id)
  if (index < 0) throw new Error('Password record not found.')
  const current = vault.records[index]
  const next: EncryptedPasswordRecord = { ...current, updatedAt: Date.now() }

  if (input.origin !== undefined) {
    const normalized = normalizeOrigin(input.origin)
    next.origin = normalized.origin
    next.hostname = normalized.hostname
  }
  if (input.username !== undefined) next.encryptedUsername = encryptVaultField(validText(input.username, 512) ?? '')
  if (input.title !== undefined) next.title = validText(input.title, 256) || next.hostname
  if (input.notes !== undefined) next.encryptedNotes = encryptVaultField(validText(input.notes, 2000) ?? '')
  if (input.favicon !== undefined) next.favicon = validText(input.favicon, 2048)
  if (input.autofillPolicy !== undefined) {
    if (input.autofillPolicy !== 'ask' && input.autofillPolicy !== 'never') throw new Error('Invalid autofill policy.')
    next.autofillPolicy = input.autofillPolicy
  }
  if (input.password !== undefined) {
    if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 4096) {
      throw new Error('Password must be between 1 and 4096 characters.')
    }
    next.encryptedPassword = encryptVaultField(input.password)
  }

  const records = [...vault.records]
  records[index] = next
  await saveVault({ ...vault, records })
  return publicItem(next)
}

export async function deletePasswordVaultItem(id: ID): Promise<void> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid password id.')
  const vault = await loadVault()
  await saveVault({ ...vault, records: vault.records.filter((record) => record.id !== id) })
}

export async function copyPasswordUsername(id: ID): Promise<void> {
  const vault = await loadVault()
  const record = vault.records.find((item) => item.id === id)
  if (!record) throw new Error('Password record not found.')
  clipboard.writeText(decryptUsername(record))
}

export async function copyPasswordSecretWithConfirmation(mainWindow: BrowserWindow, id: ID): Promise<void> {
  const vault = await loadVault()
  const record = vault.records.find((item) => item.id === id)
  if (!record) throw new Error('Password record not found.')
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Copy password',
    message: `Copy password for ${record.title} to the clipboard?`,
    detail: 'The clipboard is readable by other apps. Vast will clear it after 30 seconds if it still contains this password.',
    buttons: ['Copy password', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (result.response !== 0) throw new Error('Password copy cancelled.')
  const secret = decryptPassword(record)
  clipboard.writeText(secret)
  setTimeout(() => {
    try {
      if (clipboard.readText() === secret) clipboard.clear()
    } catch {
      // Clipboard may be unavailable during shutdown.
    }
  }, 30_000)
}

function boundAutofillWebContents(mainWindow: BrowserWindow, webContentsId: number, origin: string): Electron.WebContents | undefined {
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) return undefined
  const contents = webContents.fromId(webContentsId)
  if (!contents || contents.isDestroyed() || contents.id === mainWindow.webContents.id) return undefined
  try {
    const host = (contents as Electron.WebContents & { hostWebContents?: Electron.WebContents }).hostWebContents
    const owner = BrowserWindow.fromWebContents(host && !host.isDestroyed() ? host : contents)
    if (owner?.id !== mainWindow.id) return undefined
    return autofillRequestMatchesWebContents(
      { requestedOrigin: origin, requestedWebContentsId: webContentsId },
      { id: contents.id, url: contents.getURL() }
    ) ? contents : undefined
  } catch {
    return undefined
  }
}

function originIsBoundToWebContents(mainWindow: BrowserWindow, webContentsId: number, origin: string): boolean {
  return Boolean(boundAutofillWebContents(mainWindow, webContentsId, origin))
}

function directAutofillScript(username: string, password: string): string {
  const safeUsername = JSON.stringify(username)
  const safePassword = JSON.stringify(password)
  return `
(() => {
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const passwordInput = document.querySelector('input[type="password"]:not([disabled]):not([readonly])');
  const active = document.activeElement?.tagName === 'INPUT' ? document.activeElement : null;
  const form = passwordInput?.closest('form') || active?.closest?.('form') || document;
  const inputs = Array.from(form.querySelectorAll('input:not([disabled]):not([readonly])'));
  const usernameInput = inputs.find((input) => {
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (input === passwordInput || !['email', 'text', 'tel'].includes(type)) return false;
    const metadata = ['autocomplete', 'name', 'id', 'aria-label', 'placeholder'].map((key) => input.getAttribute(key) || '').join(' ').toLowerCase();
    return type === 'email' || /email|e-mail|username|login|user|account|phone/.test(metadata);
  }) || (active && active !== passwordInput ? active : null);
  if (usernameInput) setValue(usernameInput, ${safeUsername});
  if (passwordInput) setValue(passwordInput, ${safePassword});
  return Boolean(usernameInput || passwordInput);
})()
`
}

/**
 * Returns display-only (no password) suggestions for the autofill inline UI.
 * Safe to call without user confirmation since no secrets are returned.
 */
export async function getAutofillSuggestionsForOrigin(
  mainWindow: BrowserWindow,
  webContentsId: number,
  originInput: string
): Promise<Array<{ id: string; username: string; title: string; favicon?: string }>> {
  const { origin } = normalizeOrigin(originInput)
  if (!originIsBoundToWebContents(mainWindow, webContentsId, origin)) return []
  const vault = await loadVault()
  return vault.records
    .filter((record) => record.origin === origin && record.autofillPolicy !== 'never')
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
    .map((record) => ({
      id: record.id,
      username: decryptUsername(record),
      title: record.title,
      favicon: record.favicon
    }))
}

/**
 * Returns the full credential (including decrypted password) for a specific
 * vault entry without showing a native confirmation dialog.
 * Used when the user explicitly selects a suggestion from the inline autofill UI.
 */
export async function fillAutofillCredentialById(
  mainWindow: BrowserWindow,
  id: string,
  webContentsId: number,
  originInput: string,
  requireConfirmation = true
): Promise<boolean> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid credential id.')
  const { origin } = normalizeOrigin(originInput)
  if (!boundAutofillWebContents(mainWindow, webContentsId, origin)) {
    throw new Error('Autofill is only available for origins currently open in Vast.')
  }
  const vault = await loadVault()
  const record = vault.records.find((r) => r.id === id && r.origin === origin && r.autofillPolicy !== 'never')
  if (!record) return false
  const username = decryptUsername(record)
  if (requireConfirmation) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Fill saved login',
      message: `Fill login for ${record.hostname}?`,
      detail: `Username: ${username || '(empty username)'}\nOrigin: ${record.origin}`,
      buttons: ['Fill login', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (result.response !== 0) throw new Error('Autofill cancelled.')
  }
  const target = boundAutofillWebContents(mainWindow, webContentsId, origin)
  if (!target) throw new Error('The target page navigated before autofill completed.')
  const password = decryptPassword(record)
  const filled = Boolean(await target.executeJavaScript(directAutofillScript(username, password), true))
  const usedAt = Date.now()
  const nextRecord: EncryptedPasswordRecord = { ...record, lastUsedAt: usedAt, updatedAt: record.updatedAt || usedAt }
  await saveVault({ ...vault, records: vault.records.map((item) => (item.id === record.id ? nextRecord : item)) })
  return filled
}

export async function fillBestAutofillCredential(
  mainWindow: BrowserWindow,
  webContentsId: number,
  originInput: string
): Promise<boolean> {
  const { origin } = normalizeOrigin(originInput)
  if (!boundAutofillWebContents(mainWindow, webContentsId, origin)) {
    throw new Error('Autofill is only available for origins currently open in Vast.')
  }
  const vault = await loadVault()
  const matching = vault.records
    .filter((record) => record.origin === origin && record.autofillPolicy !== 'never')
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
  const record = matching[0]
  if (!record) return false
  const username = decryptUsername(record)
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Fill saved login',
    message: `Fill login for ${record.hostname}?`,
    detail: `Username: ${username || '(empty username)'}\nOrigin: ${record.origin}`,
    buttons: ['Fill login', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (result.response !== 0) throw new Error('Autofill cancelled.')
  const target = boundAutofillWebContents(mainWindow, webContentsId, origin)
  if (!target) throw new Error('The target page navigated before autofill completed.')
  const password = decryptPassword(record)
  const filled = Boolean(await target.executeJavaScript(directAutofillScript(username, password), true))
  const usedAt = Date.now()
  const nextRecord: EncryptedPasswordRecord = {
    ...record,
    lastUsedAt: usedAt,
    updatedAt: record.updatedAt || usedAt
  }
  await saveVault({
    ...vault,
    records: vault.records.map((item) => (item.id === record.id ? nextRecord : item))
  })
  return filled
}

export async function saveCapturedLogin(input: PasswordVaultInput): Promise<PasswordVaultItem> {
  const normalized = validateInput(input)
  const vault = await loadVault()
  const existing = vault.records.find((record) => record.origin === normalized.origin && decryptUsername(record) === normalized.username)
  if (existing) {
    return updatePasswordVaultItem(existing.id, {
      origin: normalized.origin,
      username: normalized.username,
      password: normalized.password,
      title: normalized.title,
      notes: normalized.notes,
      favicon: normalized.favicon
    })
  }
  return createPasswordVaultItem(input)
}

function matchingCapturedCredential(vault: VaultFile, origin: string, username: string): EncryptedPasswordRecord | undefined {
  const normalizedUsername = normalizedCredentialUsername(username)
  return vault.records.find((record) =>
    record.origin === origin && normalizedCredentialUsername(decryptUsername(record)) === normalizedUsername
  )
}

function validatedAutomaticOrigin(originInput: string): string {
  const origin = automaticPasswordCaptureOrigin(originInput)
  if (!origin) throw new Error('Automatic password saving is unavailable for this page.')
  return origin
}

export async function passwordCaptureEnabledForOrigin(
  mainWindow: BrowserWindow,
  webContentsId: number,
  originInput: string
): Promise<boolean> {
  const origin = validatedAutomaticOrigin(originInput)
  if (!originIsBoundToWebContents(mainWindow, webContentsId, origin)) return false
  const vault = await loadVault()
  return !vault.savePromptNeverOrigins.includes(origin)
}

export async function allowPasswordSavePrompts(originInput: string): Promise<void> {
  const origin = validatedAutomaticOrigin(originInput)
  const vault = await loadVault()
  if (!vault.savePromptNeverOrigins.includes(origin)) return
  await saveVault({
    ...vault,
    savePromptNeverOrigins: vault.savePromptNeverOrigins.filter((item) => item !== origin)
  })
}

export async function promptToSaveCapturedLogin(
  mainWindow: BrowserWindow,
  webContentsId: number,
  input: PasswordLoginCandidate
): Promise<{ outcome: PasswordCaptureOutcome; item?: PasswordVaultItem }> {
  const candidate = sanitizePasswordLoginCandidate(input)
  if (!originIsBoundToWebContents(mainWindow, webContentsId, candidate.origin)) {
    throw new Error('Captured login origin does not match the active page.')
  }

  const normalized = validateInput(candidate)
  const vault = await loadVault()
  const existing = matchingCapturedCredential(vault, normalized.origin, normalized.username)
  const action = classifyPasswordCapture({
    suppressed: vault.savePromptNeverOrigins.includes(normalized.origin),
    hasExistingCredential: Boolean(existing),
    passwordMatches: existing ? decryptPassword(existing) === normalized.password : false
  })

  if (action === 'suppressed') return { outcome: 'suppressed' }
  if (action === 'unchanged' && existing) {
    const usedAt = Date.now()
    await saveVault({
      ...vault,
      records: vault.records.map((record) => record.id === existing.id ? { ...record, lastUsedAt: usedAt } : record)
    })
    return { outcome: 'unchanged', item: publicItem(existing) }
  }

  const captureKey = createHash('sha256')
    .update(`${mainWindow.id}\u0000${webContentsId}\u0000${normalized.origin}\u0000${normalized.username}\u0000${normalized.password}`)
    .digest('hex')
  if (pendingCaptureKeys.has(captureKey)) return { outcome: 'duplicate' }
  pendingCaptureKeys.add(captureKey)

  try {
    const promptAction = await requestRendererPrompt(mainWindow, {
      tone: 'question',
      title: action === 'update' ? 'Update saved password?' : 'Save this password?',
      message: action === 'update'
        ? `Vast detected a changed password for ${normalized.hostname}.`
        : `Vast detected a completed sign-in on ${normalized.hostname}.`,
      detail: `Username: ${normalized.username || '(empty username)'}\nSite: ${normalized.origin}\nStored locally with OS-backed encryption.`,
      actions: [
        { id: action, label: action === 'update' ? 'Update password' : 'Save password', tone: 'primary' },
        { id: 'never', label: 'Never for this site' },
        { id: 'dismiss', label: 'Not now' }
      ]
    }, 90_000)

    if (promptAction === 'never') {
      const latest = await loadVault()
      if (!latest.savePromptNeverOrigins.includes(normalized.origin)) {
        await saveVault({ ...latest, savePromptNeverOrigins: [...latest.savePromptNeverOrigins, normalized.origin].slice(-500) })
      }
      showRendererNotification(mainWindow, {
        tone: 'info',
        title: 'Password prompts disabled',
        message: `Vast will not suggest saving passwords on ${normalized.hostname}.`,
        detail: 'You can enable prompts again from Password Manager.'
      })
      return { outcome: 'suppressed' }
    }
    if (promptAction !== action) return { outcome: 'dismissed' }

    const item = await saveCapturedLogin({
      origin: normalized.origin,
      username: normalized.username,
      password: normalized.password,
      title: normalized.title,
      favicon: normalized.favicon
    })
    showRendererNotification(mainWindow, {
      tone: 'success',
      title: action === 'update' ? 'Password updated' : 'Password saved',
      message: `${normalized.hostname} is ready for Vast autofill.`,
      detail: normalized.username || 'Saved without a username.'
    })
    return { outcome: action === 'update' ? 'updated' : 'saved', item }
  } finally {
    pendingCaptureKeys.delete(captureKey)
  }
}

export async function importPasswordsCsv(mainWindow: BrowserWindow): Promise<{ imported: number; skipped: number }> {
  ensureEncryptionAvailable()
  let filePath = !app.isPackaged ? process.env.VAST_TEST_PASSWORD_IMPORT_CSV : undefined
  if (!filePath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import passwords CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePaths[0]) throw new Error('Import cancelled.')
    filePath = result.filePaths[0]
  }
  const raw = await readFile(filePath, 'utf8')
  if (raw.length > maxPasswordCsvBytes) throw new Error('CSV file is too large to import safely.')
  const parsed = parsePasswordImportCsv(raw)
  if (parsed.items.length + parsed.skipped > maxPasswordCsvRows) throw new Error(`CSV import is limited to ${maxPasswordCsvRows} rows.`)
  if (!process.env.VAST_TEST_PASSWORD_IMPORT_CSV) {
    const sample = parsed.items.slice(0, 5).map((item) => {
      try { return new URL(item.origin.includes('://') ? item.origin : `https://${item.origin}`).hostname } catch { return 'invalid origin' }
    })
    const preview = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Preview password import',
      message: `Import ${parsed.items.length} valid login${parsed.items.length === 1 ? '' : 's'}?`,
      detail: [`Skipped before import: ${parsed.skipped}`, sample.length ? `Sample sites: ${sample.join(', ')}` : 'No valid rows found.', 'Existing entries with the same site and username are updated instead of duplicated.'].join('\n'),
      buttons: ['Import encrypted logins', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (preview.response !== 0) throw new Error('Import cancelled.')
  }
  let imported = 0
  let skipped = parsed.skipped
  for (const item of parsed.items) {
    try {
      await saveCapturedLogin(item)
      imported += 1
    } catch {
      skipped += 1
    }
  }
  return { imported, skipped }
}

export async function exportPasswordsCsv(mainWindow: BrowserWindow): Promise<{ path: string }> {
  const confirmed = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Export plaintext passwords',
    message: 'Export every saved password as readable CSV?',
    detail: 'Anyone with this file can read the exported passwords. Keep it encrypted or delete it after use.',
    buttons: ['Export plaintext CSV', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (confirmed.response !== 0) throw new Error('Plaintext CSV export cancelled.')
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export passwords as plaintext CSV',
    defaultPath: 'vast-passwords.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (result.canceled || !result.filePath) throw new Error('Export cancelled.')
  const vault = await loadVault()
  const lines = ['name,url,username,password,note']
  for (const record of vault.records) {
    lines.push(
      [
        passwordCsvCell(record.title),
        passwordCsvCell(record.origin),
        passwordCsvCell(decryptUsername(record)),
        passwordCsvCell(decryptPassword(record)),
        passwordCsvCell(decryptNotes(record))
      ].join(',')
    )
  }
  await writeFile(result.filePath, `${lines.join('\n')}\n`, 'utf8')
  return { path: result.filePath }
}
