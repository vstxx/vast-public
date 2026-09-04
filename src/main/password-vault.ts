import { app, BrowserWindow, clipboard, dialog, safeStorage, webContents } from 'electron/main'
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
import type { CredentialSubmissionCandidate } from '../shared/password-capture-policy'
import { automaticPasswordCaptureOrigin } from '../shared/password-capture-policy'
import { canonicalCredentialUsername, resolveCredentialMatch, type CredentialMatchPlan, type CredentialMatchRecord } from '../shared/credential-matching'
import { parsePasswordImportCsv, passwordCsvCell } from '../shared/password-csv'
import { autofillRequestMatchesWebContents } from './autofill-binding'
import { dataFilePath } from './data-path'
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
let credentialMutationChain: Promise<void> = Promise.resolve()

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
    const duplicateKey = `${record.origin}\u0000${canonicalCredentialUsername(decryptUsername(record))}`
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
  return runCredentialMutation(async () => {
    const vault = await loadVault()
    const plan = resolveCredentialMatch({
      origin: normalized.origin,
      username: normalized.username,
      password: normalized.password,
      kind: 'login'
    }, credentialMatchRecords(vault))
    if (plan.action === 'unchanged') {
      const existing = vault.records.find((record) => record.id === plan.recordId)
      if (existing) return publicItem(existing)
    }
    if (plan.action !== 'save') {
      throw new Error('A login for this site and username already exists. Edit the existing login instead.')
    }
    const record = createCapturedRecord(normalized)
    await saveVault({ ...vault, records: [record, ...vault.records] })
    return publicItem(record)
  })
}

export async function updatePasswordVaultItem(id: ID, input: PasswordVaultUpdate): Promise<PasswordVaultItem> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid password id.')
  return runCredentialMutation(async () => {
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

    const canonicalUsername = canonicalCredentialUsername(decryptUsername(next))
    const duplicate = vault.records.some((record) =>
      record.id !== id &&
      record.origin === next.origin &&
      canonicalCredentialUsername(decryptUsername(record)) === canonicalUsername
    )
    if (duplicate) throw new Error('Another login for this site already uses this username.')

    const records = [...vault.records]
    records[index] = next
    await saveVault({ ...vault, records })
    return publicItem(next)
  })
}

export async function deletePasswordVaultItem(id: ID): Promise<void> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid password id.')
  await runCredentialMutation(async () => {
    const vault = await loadVault()
    await saveVault({ ...vault, records: vault.records.filter((record) => record.id !== id) })
  })
}

export async function copyPasswordUsername(id: ID): Promise<void> {
  const vault = await loadVault()
  const record = vault.records.find((item) => item.id === id)
  if (!record) throw new Error('Password record not found.')
  await clipboard.writeText(decryptUsername(record))
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
  await clipboard.writeText(secret)
  setTimeout(() => {
    void (async () => {
    try {
      if (await clipboard.readText() === secret) clipboard.clear()
    } catch {
      // Clipboard may be unavailable during shutdown.
    }
    })()
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

function deliverAutofillCredential(
  target: Electron.WebContents,
  input: {
    id: string
    origin: string
    username: string
    password: string
    requestId?: string
    trustedSurfaceAction?: boolean
  }
): boolean {
  if (target.isDestroyed()) return false
  // The browser renderer never handles plaintext secrets. Main sends the
  // credential directly to the isolated guest preload, which has no page API.
  target.send('vast:password-autofill-fill', input)
  return true
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
  requestId: string,
  requireConfirmation = true,
  onAuthorized?: () => unknown
): Promise<boolean> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid credential id.')
  if (!/^[a-f0-9]{32}$/i.test(requestId)) throw new Error('Invalid autofill request id.')
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
  onAuthorized?.()
  const password = decryptPassword(record)
  const filled = deliverAutofillCredential(target, { id: record.id, origin, username, password, requestId })
  const usedAt = Date.now()
  await runCredentialMutation(async () => {
    const latest = await loadVault()
    const current = latest.records.find((item) => item.id === record.id)
    if (!current) return
    const nextRecord: EncryptedPasswordRecord = { ...current, lastUsedAt: usedAt, updatedAt: current.updatedAt || usedAt }
    await saveVault({ ...latest, records: latest.records.map((item) => (item.id === current.id ? nextRecord : item)) })
  })
  return filled
}

export async function fillBestAutofillCredential(
  mainWindow: BrowserWindow,
  webContentsId: number,
  originInput: string,
  onAuthorized?: () => unknown
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
  onAuthorized?.()
  const password = decryptPassword(record)
  const filled = deliverAutofillCredential(target, {
    id: record.id,
    origin,
    username,
    password,
    trustedSurfaceAction: true
  })
  const usedAt = Date.now()
  await runCredentialMutation(async () => {
    const latest = await loadVault()
    const current = latest.records.find((item) => item.id === record.id)
    if (!current) return
    const nextRecord: EncryptedPasswordRecord = {
      ...current,
      lastUsedAt: usedAt,
      updatedAt: current.updatedAt || usedAt
    }
    await saveVault({
      ...latest,
      records: latest.records.map((item) => (item.id === current.id ? nextRecord : item))
    })
  })
  return filled
}

export async function saveCapturedLogin(input: PasswordVaultInput): Promise<PasswordVaultItem> {
  const normalized = validateInput(input)
  return runCredentialMutation(async () => {
    const vault = await loadVault()
    const plan = resolveCredentialMatch({
      origin: normalized.origin,
      username: normalized.username,
      password: normalized.password,
      kind: 'login'
    }, credentialMatchRecords(vault))
    const result = await applyCredentialPlan(vault, normalized, plan)
    if (!result.item) throw new Error('The captured credential could not be matched safely.')
    return result.item
  })
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
  await runCredentialMutation(async () => {
    const vault = await loadVault()
    if (!vault.savePromptNeverOrigins.includes(origin)) return
    await saveVault({
      ...vault,
      savePromptNeverOrigins: vault.savePromptNeverOrigins.filter((item) => item !== origin)
    })
  })
}

export interface PreparedCapturedCredential {
  action: 'save' | 'update' | 'unchanged' | 'suppressed' | 'ignore'
  recordId?: string
  hostname: string
  username: string
  reason?: string
  item?: PasswordVaultItem
}

function credentialMatchRecords(vault: VaultFile): CredentialMatchRecord[] {
  return vault.records.map((record) => ({
    id: record.id,
    origin: record.origin,
    username: decryptUsername(record),
    password: decryptPassword(record),
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt
  }))
}

function runCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialMutationChain.then(operation, operation)
  credentialMutationChain = result.then(() => undefined, () => undefined)
  return result
}

function createCapturedRecord(
  normalized: ReturnType<typeof validateInput>,
  now = Date.now()
): EncryptedPasswordRecord {
  return {
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
}

async function applyCredentialPlan(
  vault: VaultFile,
  normalized: ReturnType<typeof validateInput>,
  plan: CredentialMatchPlan
): Promise<{ outcome: PasswordCaptureOutcome; item?: PasswordVaultItem }> {
  if (plan.action === 'ignore') return { outcome: 'dismissed' }
  if (plan.action === 'save') {
    const record = createCapturedRecord(normalized)
    await saveVault({ ...vault, records: [record, ...vault.records] })
    return { outcome: 'saved', item: publicItem(record) }
  }
  const index = vault.records.findIndex((record) => record.id === plan.recordId)
  if (index < 0) return { outcome: 'dismissed' }
  const current = vault.records[index]
  const now = Date.now()
  if (plan.action === 'unchanged') {
    const next = { ...current, lastUsedAt: now }
    const records = [...vault.records]
    records[index] = next
    await saveVault({ ...vault, records })
    return { outcome: 'unchanged', item: publicItem(next) }
  }
  const preserveUsername = !normalized.username && decryptUsername(current)
  const next: EncryptedPasswordRecord = {
    ...current,
    hostname: normalized.hostname,
    title: normalized.title || current.title,
    encryptedUsername: encryptVaultField(preserveUsername || normalized.username),
    encryptedPassword: encryptVaultField(normalized.password),
    favicon: normalized.favicon ?? current.favicon,
    updatedAt: now,
    lastUsedAt: now
  }
  const records = [...vault.records]
  records[index] = next
  await saveVault({ ...vault, records })
  return { outcome: 'updated', item: publicItem(next) }
}

function matchPlanForCandidate(vault: VaultFile, candidate: CredentialSubmissionCandidate): {
  normalized: ReturnType<typeof validateInput>
  plan: CredentialMatchPlan
} {
  const normalized = validateInput(candidate)
  const plan = resolveCredentialMatch({
    origin: normalized.origin,
    username: normalized.username,
    password: normalized.password,
    kind: candidate.kind,
    currentPassword: candidate.currentPassword
  }, credentialMatchRecords(vault))
  return { normalized, plan }
}

export async function prepareCapturedCredential(candidate: CredentialSubmissionCandidate): Promise<PreparedCapturedCredential> {
  const vault = await loadVault()
  const { normalized, plan } = matchPlanForCandidate(vault, candidate)
  if (vault.savePromptNeverOrigins.includes(normalized.origin)) {
    return { action: 'suppressed', hostname: normalized.hostname, username: normalized.username }
  }
  if (plan.action === 'ignore') {
    return { action: 'ignore', hostname: normalized.hostname, username: normalized.username, reason: plan.reason }
  }
  if (plan.action === 'unchanged') {
    const result = await runCredentialMutation(async () => {
      const latest = await loadVault()
      const latestMatch = matchPlanForCandidate(latest, candidate)
      if (latestMatch.plan.action !== 'unchanged' || latestMatch.plan.recordId !== plan.recordId) {
        return { outcome: 'dismissed' as const }
      }
      return applyCredentialPlan(latest, latestMatch.normalized, latestMatch.plan)
    })
    return {
      action: result.outcome === 'unchanged' ? 'unchanged' : 'ignore',
      recordId: plan.recordId,
      hostname: normalized.hostname,
      username: normalized.username,
      item: result.item
    }
  }
  return {
    action: plan.action,
    recordId: plan.action === 'update' ? plan.recordId : undefined,
    hostname: normalized.hostname,
    username: normalized.username
  }
}

export async function commitCapturedCredential(
  candidate: CredentialSubmissionCandidate,
  expectedAction: 'save' | 'update',
  expectedRecordId?: string
): Promise<{ outcome: PasswordCaptureOutcome; item?: PasswordVaultItem }> {
  return runCredentialMutation(async () => {
    const vault = await loadVault()
    const { normalized, plan } = matchPlanForCandidate(vault, candidate)
    if (vault.savePromptNeverOrigins.includes(normalized.origin)) return { outcome: 'suppressed' }
    if (expectedAction === 'update') {
      if ((plan.action !== 'update' && plan.action !== 'unchanged') || plan.recordId !== expectedRecordId) {
        return { outcome: 'dismissed' }
      }
    } else if (plan.action === 'update') {
      // A Save prompt must never become an implicit update if the vault
      // changes while the user is deciding. Exact concurrent duplicates may
      // safely resolve as unchanged; changed credentials require a new prompt.
      return { outcome: 'dismissed' }
    }
    return applyCredentialPlan(vault, normalized, plan)
  })
}

export async function suppressPasswordSavePrompts(originInput: string): Promise<void> {
  const origin = validatedAutomaticOrigin(originInput)
  await runCredentialMutation(async () => {
    const vault = await loadVault()
    if (vault.savePromptNeverOrigins.includes(origin)) return
    await saveVault({ ...vault, savePromptNeverOrigins: [...vault.savePromptNeverOrigins, origin].slice(-500) })
  })
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
