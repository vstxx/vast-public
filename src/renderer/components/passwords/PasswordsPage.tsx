import {
  AlertTriangle,
  BadgeCheck,
  Copy,
  Download,
  KeyRound,
  Lock,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Unlock,
  Upload,
  X
} from 'lucide-react'
import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { PasswordVaultAudit, PasswordVaultItem } from '../../../shared/types'
import { InternalLoadingSkeleton } from '../internal/InternalPage'
import { VastSelect } from '../ui/VastSelect'
import { useVastConfirm } from '../ui/useVastConfirm'

interface PasswordFormState {
  origin: string
  username: string
  password: string
  title: string
  notes: string
  autofillPolicy: 'ask' | 'never'
}

const emptyForm: PasswordFormState = {
  origin: '',
  username: '',
  password: '',
  title: '',
  notes: '',
  autofillPolicy: 'ask'
}

function formatDate(value?: number): string {
  if (!value) return 'Never'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}

function insecureOrigin(origin: string): boolean {
  return origin.startsWith('http://')
}

function toForm(item: PasswordVaultItem): PasswordFormState {
  return {
    origin: item.origin,
    username: item.username,
    password: '',
    title: item.title,
    notes: item.notes ?? '',
    autofillPolicy: item.autofillPolicy ?? 'ask'
  }
}

function passwordStrength(password: string): { label: string; tone: string } {
  if (!password) return { label: 'Not set', tone: 'text-vast-soft' }
  const classes = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length
  if (password.length >= 16 && classes >= 3) return { label: 'Strong', tone: 'text-vast-mint' }
  if (password.length >= 12 && classes >= 3) return { label: 'Good', tone: 'text-vast-cyan' }
  return { label: 'Weak', tone: 'text-vast-amber' }
}

function generatedPassword(length = 20): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digits = '23456789'
  const symbols = '!@#$%^&*_-+='
  const alphabet = `${lower}${upper}${digits}${symbols}`
  const random = new Uint32Array(length)
  crypto.getRandomValues(random)
  const output = [lower[random[0] % lower.length], upper[random[1] % upper.length], digits[random[2] % digits.length], symbols[random[3] % symbols.length]]
  for (let index = 4; index < length; index += 1) output.push(alphabet[random[index] % alphabet.length])
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = random[index] % (index + 1)
    ;[output[index], output[swap]] = [output[swap], output[index]]
  }
  return output.join('')
}

export function PasswordsPage(): JSX.Element {
  const confirm = useVastConfirm()
  const [items, setItems] = useState<PasswordVaultItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PasswordFormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [sessionLocked, setSessionLocked] = useState(true)
  const [audit, setAudit] = useState<PasswordVaultAudit | null>(null)
  const [auditBusy, setAuditBusy] = useState(false)
  const [suppressedOrigins, setSuppressedOrigins] = useState<string[]>([])
  const deferredQuery = useDeferredValue(query)

  const applyLockedState = (message = 'Password Manager is locked.'): void => {
    setSessionLocked(true)
    setItems([])
    setSelectedId(null)
    setAudit(null)
    setFormOpen(false)
    setForm(emptyForm)
    setMessage(message)
  }

  const refresh = async (): Promise<void> => {
    setLoading(true)
    const result: Awaited<ReturnType<typeof window.vast.passwords.list>> = await window.vast.passwords.list().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    startTransition(() => {
      if (result.ok) {
        const nextItems = result.items ?? []
        setItems(nextItems)
        setEncryptionAvailable(result.encryptionAvailable !== false)
        setSuppressedOrigins(result.suppressedOrigins ?? [])
        setSelectedId((current) => (current && nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? null))
      } else {
        setMessage(result.error ?? 'Could not load password vault.')
      }
      setLoading(false)
    })
  }

  useEffect(() => {
    let cancelled = false
    void window.vast.passwords.sessionStatus().then((result) => {
      if (cancelled) return
      if (!result.ok || result.state?.locked !== false) {
        applyLockedState(result.error ?? 'Password Manager is locked after startup.')
        setLoading(false)
        return
      }
      setSessionLocked(false)
      void refresh()
    }).catch((error: unknown) => {
      if (!cancelled) {
        applyLockedState(error instanceof Error ? error.message : String(error))
        setLoading(false)
      }
    })
    const unsubscribe = window.vast.passwords.onSessionState((state) => {
      if (state.locked) applyLockedState(`Password Manager locked: ${state.reason.replace('-', ' ')}.`)
      else setSessionLocked(false)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      `${item.title} ${item.origin} ${item.hostname} ${item.username}`.toLowerCase().includes(needle)
    )
  }, [deferredQuery, items])

  const selected = items.find((item) => item.id === selectedId) ?? filtered[0]

  const openCreate = (): void => {
    setEditingId(null)
    setForm(emptyForm)
    setFormOpen(true)
    setMessage(null)
  }

  const openEdit = (item: PasswordVaultItem): void => {
    setEditingId(item.id)
    setForm(toForm(item))
    setFormOpen(true)
    setMessage('Leave password blank to keep the existing encrypted password.')
  }

  const saveForm = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = editingId
        ? await window.vast.passwords.update(editingId, {
            origin: form.origin,
            username: form.username,
            title: form.title,
            notes: form.notes,
            autofillPolicy: form.autofillPolicy,
            password: form.password || undefined
          })
        : await window.vast.passwords.create(form)
      if (!result.ok) {
        setMessage(result.error ?? 'Could not save password.')
        return
      }
      setFormOpen(false)
      setEditingId(null)
      await refresh()
      setSelectedId(result.item?.id ?? selectedId)
      setMessage('Login saved in the encrypted Vast vault.')
    } finally {
      setBusy(false)
    }
  }

  const removeSelected = async (item: PasswordVaultItem): Promise<void> => {
    if (!await confirm(`Delete password for ${item.title}?`, 'This removes the encrypted local record.', 'Delete password')) return
    const result = await window.vast.passwords.remove(item.id)
    if (!result.ok) {
      setMessage(result.error ?? 'Could not delete password.')
      return
    }
    setSelectedId(null)
    await refresh()
    setMessage('Login deleted.')
  }

  const copyUsername = async (item: PasswordVaultItem): Promise<void> => {
    const result = await window.vast.passwords.copyUsername(item.id)
    setMessage(result.ok ? 'Username copied.' : result.error ?? 'Could not copy username.')
  }

  const copyPassword = async (item: PasswordVaultItem): Promise<void> => {
    const result = await window.vast.passwords.copyPassword(item.id)
    setMessage(result.ok ? 'Password copied to clipboard for 30 seconds.' : result.error ?? 'Could not copy password.')
  }

  const importCsv = async (): Promise<void> => {
    const result = await window.vast.passwords.importCsv()
    if (result.ok) {
      await refresh()
      const count = result.imported ?? 0
      const skipped = result.skipped ?? 0
      const msg = `Imported ${count} password${count === 1 ? '' : 's'} from CSV.`
      setMessage(skipped > 0 ? `${msg} Skipped ${skipped} invalid row${skipped === 1 ? '' : 's'}.` : msg)
    } else {
      setMessage(result.error ?? 'CSV import cancelled.')
    }
  }

  const exportCsv = async (): Promise<void> => {
    const result = await window.vast.passwords.exportCsv()
    setMessage(result.ok ? 'Plaintext CSV export complete.' : result.error ?? 'CSV export cancelled.')
  }

  const allowSavePrompts = async (origin: string): Promise<void> => {
    const result = await window.vast.passwords.allowSavePrompts(origin)
    if (!result.ok) {
      setMessage(result.error ?? 'Could not enable password prompts for this site.')
      return
    }
    setSuppressedOrigins((current) => current.filter((item) => item !== origin))
    setMessage(`Automatic save prompts enabled again for ${new URL(origin).hostname}.`)
  }

  const lockSession = async (): Promise<void> => {
    const result = await window.vast.passwords.lockSession()
    if (!result.ok) {
      setMessage(result.error ?? 'Could not lock Password Manager.')
      return
    }
    applyLockedState('Password Manager locked in the main process.')
  }

  const unlockSession = async (): Promise<void> => {
    const result = await window.vast.passwords.unlockSession()
    if (!result.ok) {
      setMessage(result.error ?? 'Unlock cancelled.')
      return
    }
    if (result.state?.locked !== false) {
      applyLockedState('Password Manager remained locked.')
      return
    }
    setSessionLocked(false)
    await refresh()
    setMessage('Password Manager unlocked for this Vast session.')
  }

  const runAudit = async (): Promise<void> => {
    setAuditBusy(true)
    try {
      const result = await window.vast.passwords.audit()
      if (!result.ok || !result.audit) {
        setMessage(result.error ?? 'Could not audit the password vault.')
        return
      }
      setAudit(result.audit)
      const affected = new Set([...result.audit.weakIds, ...result.audit.reusedGroups.flat(), ...result.audit.duplicateIds]).size
      setMessage(affected === 0 ? 'Password health check found no obvious local issues.' : `Password health check found ${affected} login${affected === 1 ? '' : 's'} to review.`)
    } finally {
      setAuditBusy(false)
    }
  }

  const auditFlags = (id: string): string[] => {
    if (!audit) return []
    const flags: string[] = []
    if (audit.weakIds.includes(id)) flags.push('Weak')
    if (audit.reusedGroups.some((group) => group.includes(id))) flags.push('Reused')
    if (audit.duplicateIds.includes(id)) flags.push('Duplicate')
    return flags
  }

  return (
    <div className="labs-page-surface min-h-full overflow-hidden bg-[#06070a] text-white" data-testid="passwords-page">
      <div className="mx-auto flex h-full min-h-[720px] w-full max-w-7xl flex-col gap-5 p-5 md:p-7">
        <section className="vast-glass-panel relative overflow-hidden rounded-[32px] p-6">
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-4xl font-semibold tracking-normal md:text-5xl">Password Manager</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-vast-soft">
                Vast evaluates sign-in results before offering to save or update a password, and offers matching logins
                only on the same site. Secrets stay OS-encrypted in the main process; CSV import/export is manual only.
              </p>
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 lg:w-[33rem]" data-testid="password-vault-header-actions">
              <div className={`flex h-11 min-w-0 items-center justify-center gap-2 rounded-2xl border px-2 text-sm font-semibold ${sessionLocked ? 'border-vast-amber/25 bg-vast-amber/[0.08] text-vast-amber' : 'border-vast-mint/25 bg-vast-mint/[0.08] text-vast-mint'}`}>
                {sessionLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                {sessionLocked ? 'Locked' : 'Unlocked'}
              </div>
              {sessionLocked ? (
                <button type="button" onClick={() => void unlockSession()} className="vault-action-button h-11 min-w-0 justify-center px-2">
                  <Unlock className="h-4 w-4" />
                  Unlock
                </button>
              ) : (
                <button type="button" onClick={() => void lockSession()} className="vault-action-button h-11 min-w-0 justify-center px-2">
                  <Lock className="h-4 w-4" />
                  Lock
                </button>
              )}
              <button type="button" onClick={() => void runAudit()} disabled={sessionLocked || auditBusy || !encryptionAvailable} className="vault-action-button h-11 min-w-0 justify-center px-2 disabled:cursor-not-allowed disabled:opacity-40">
                <RefreshCw className={`h-4 w-4 ${auditBusy ? 'animate-spin' : ''}`} />
                Check health
              </button>
              <button type="button" onClick={openCreate} disabled={sessionLocked} className="flex h-11 min-w-0 items-center justify-center gap-2 rounded-2xl bg-vast-cyan px-2 text-sm font-semibold text-black hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" data-testid="password-add-button">
                <Plus className="h-4 w-4" />
                Add login
              </button>
              <button type="button" onClick={() => void importCsv()} disabled={sessionLocked} className="flex h-11 min-w-0 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.055] px-2 text-sm font-semibold text-white hover:bg-white/[0.085] disabled:cursor-not-allowed disabled:opacity-40">
                <Upload className="h-4 w-4 text-vast-cyan" />
                Import CSV
              </button>
              <button type="button" onClick={() => void exportCsv()} disabled={sessionLocked} className="flex h-11 min-w-0 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.055] px-2 text-sm font-semibold text-white hover:bg-white/[0.085] disabled:cursor-not-allowed disabled:opacity-40">
                <Download className="h-4 w-4 text-vast-amber" />
                Export CSV
              </button>
            </div>
          </div>
        </section>

        {!encryptionAvailable && (
          <div className="rounded-2xl border border-vast-amber/25 bg-vast-amber/[0.08] px-4 py-3 text-sm text-vast-soft">
            OS password encryption is not available. Vast will not create or reveal passwords until safeStorage is available.
          </div>
        )}
        {message && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.055] px-4 py-3 text-sm text-vast-soft" data-testid="password-message">
            {message}
          </div>
        )}

        <section className="vast-glass-panel rounded-[24px] px-4 py-3" data-testid="password-auto-save-status">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <BadgeCheck className="h-4 w-4 text-vast-mint" />
                Automatic save suggestions are on
              </div>
            </div>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-vast-soft">
              {suppressedOrigins.length === 0 ? 'All eligible sites' : `${suppressedOrigins.length} excluded`}
            </span>
          </div>
          {suppressedOrigins.length > 0 && (
            <div className="mt-3 grid gap-2 border-t border-white/[0.07] pt-3 sm:grid-cols-2">
              {suppressedOrigins.map((origin) => (
                <div key={origin} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2">
                  <span className="min-w-0 truncate text-xs text-vast-soft">{origin}</span>
                  <button type="button" onClick={() => void allowSavePrompts(origin)} className="shrink-0 text-xs font-semibold text-vast-cyan hover:text-white">
                    Allow again
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {audit && !sessionLocked && (
          <div className="grid gap-3 sm:grid-cols-3" aria-label="Password health summary">
            <VaultHealth label="Weak" value={audit.weakIds.length} detail="Short or low character variety" />
            <VaultHealth label="Reused" value={audit.reusedGroups.reduce((sum, group) => sum + group.length, 0)} detail="Entries sharing the same secret" />
            <VaultHealth label="Duplicates" value={audit.duplicateIds.length} detail="Same origin and username" />
          </div>
        )}

        {sessionLocked ? (
          <section className="vast-glass-panel grid min-h-[420px] flex-1 place-items-center rounded-[28px] p-8 text-center">
            <div className="max-w-lg">
              <LockKeyhole className="mx-auto mb-5 h-12 w-12 text-vast-cyan" />
              <h2 className="text-2xl font-semibold">Password Manager is locked</h2>
              <p className="mt-3 text-sm leading-6 text-vast-soft">This privacy curtain clears decrypted metadata from the renderer. Secret copy and plaintext export always require their own native confirmation.</p>
              <button type="button" onClick={() => void unlockSession()} className="mt-6 inline-flex h-11 items-center gap-2 rounded-2xl bg-vast-cyan px-5 text-sm font-semibold text-black">
                <Unlock className="h-4 w-4" />
                Unlock this window
              </button>
              <div className="mt-4 text-xs leading-5 text-vast-soft">Windows Hello is not exposed as a stable Electron API; Vast does not pretend that a confirmation dialog is biometric authentication.</div>
            </div>
          </section>
        ) : (

        <section className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[390px_minmax(0,1fr)]">
          <div className="vast-glass-panel flex min-h-0 flex-col rounded-[28px] p-4">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search saved logins"
                className="h-11 w-full rounded-2xl border border-white/10 bg-black/20 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-vast-soft focus:border-vast-cyan/40"
                data-testid="password-search-input"
              />
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto">
              {loading && items.length === 0 ? (
                <div className="space-y-3">
                  <InternalLoadingSkeleton title="Loading vault" lines={4} />
                  <InternalLoadingSkeleton title="Decrypting metadata" lines={3} />
                </div>
              ) : filtered.length === 0 ? (
                <div className="grid h-full place-items-center rounded-3xl border border-dashed border-white/10 bg-white/[0.025] p-8 text-center">
                  <div>
                    <LockKeyhole className="mx-auto mb-4 h-8 w-8 text-vast-cyan" />
                    <div className="text-sm font-semibold text-white">No saved logins</div>
                    <div className="mt-2 text-xs leading-5 text-vast-soft">Add a login or import a Chrome-compatible CSV file.</div>
                  </div>
                </div>
              ) : (
                filtered.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left transition ${
                      selected?.id === item.id ? 'bg-white/[0.09] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]' : 'hover:bg-white/[0.055]'
                    }`}
                    data-testid="password-row"
                  >
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-vast-cyan/10 text-vast-cyan">
                      <KeyRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-white">{item.title}</div>
                      <div className="truncate text-xs text-vast-soft">{item.username || 'No username'} - {item.hostname}</div>
                      {auditFlags(item.id).length > 0 && <div className="mt-1 truncate text-xs font-semibold text-vast-amber">{auditFlags(item.id).join(' · ')}</div>}
                    </div>
                    {insecureOrigin(item.origin) && <AlertTriangle className="h-4 w-4 text-vast-amber" />}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="vast-glass-panel min-h-0 rounded-[28px] p-5">
            {loading && items.length === 0 ? (
              <InternalLoadingSkeleton title="Opening vault entry" lines={6} className="h-full min-h-[320px]" />
            ) : selected ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex flex-col gap-4 border-b border-white/10 pb-5">
                  <div className="min-w-0">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#b7a7ff]/15 text-[#b7a7ff]">
                        <LockKeyhole className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-2xl font-semibold">{selected.title}</h2>
                        <div className="truncate text-sm text-vast-soft">{selected.origin}</div>
                      </div>
                    </div>
                    {insecureOrigin(selected.origin) && (
                      <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-vast-amber/20 bg-vast-amber/[0.08] px-3 py-1.5 text-xs font-semibold text-vast-amber">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Insecure HTTP origin
                      </div>
                    )}
                  </div>
                  <div className="grid w-full grid-cols-2 gap-2 md:grid-cols-4" data-testid="password-entry-actions">
                    <button type="button" onClick={() => void copyUsername(selected)} className="vault-action-button min-w-0 justify-center px-2" title="Copy username" aria-label="Copy username">
                      <Copy className="h-4 w-4" />
                      Username
                    </button>
                    <button type="button" onClick={() => void copyPassword(selected)} className="vault-action-button min-w-0 justify-center px-2" title="Copy password" aria-label="Copy password">
                      <KeyRound className="h-4 w-4" />
                      Password
                    </button>
                    <button type="button" onClick={() => openEdit(selected)} className="vault-action-button min-w-0 justify-center px-2">
                      <Pencil className="h-4 w-4" />
                      Edit
                    </button>
                    <button type="button" onClick={() => void removeSelected(selected)} className="vault-danger-button min-w-0 justify-center px-2">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>
                <div className="grid gap-4 py-5 md:grid-cols-3">
                  <Detail label="Username" value={selected.username || 'No username'} />
                  <Detail label="Created" value={formatDate(selected.createdAt)} />
                  <Detail label="Last used" value={formatDate(selected.lastUsedAt)} />
                </div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.075] bg-white/[0.04] p-4">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-vast-soft">Autofill rule</div>
                    <div className="mt-1 text-sm text-white">{selected.autofillPolicy === 'never' ? 'Never offer on this domain' : 'Ask before filling'}</div>
                  </div>
                  <VastSelect
                    value={selected.autofillPolicy ?? 'ask'}
                    options={[
                      { value: 'ask', label: 'Ask before filling' },
                      { value: 'never', label: 'Never on this domain' }
                    ]}
                    onChange={(autofillPolicy) => {
                      void window.vast.passwords.update(selected.id, { autofillPolicy }).then(async (result) => {
                        if (result.ok) await refresh()
                        else setMessage(result.error ?? 'Could not update autofill rule.')
                      })
                    }}
                    ariaLabel="Autofill rule"
                    className="min-w-[13rem]"
                    buttonClassName="h-10 min-h-10 rounded-xl"
                  />
                </div>
                {auditFlags(selected.id).length > 0 && (
                  <div className="mb-4 flex items-start gap-3 rounded-2xl border border-vast-amber/25 bg-vast-amber/[0.08] p-4">
                    <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-vast-amber" />
                    <div><div className="text-sm font-semibold text-white">Review: {auditFlags(selected.id).join(', ')}</div><div className="mt-1 text-xs leading-5 text-vast-soft">The check runs locally. Passwords and hashes never leave the Electron main process.</div></div>
                  </div>
                )}
                <div className="rounded-3xl border border-white/[0.075] bg-black/20 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-vast-soft">Notes</div>
                  <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/[0.85]">{selected.notes || 'No notes saved.'}</div>
                </div>
              </div>
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <KeyRound className="mx-auto mb-4 h-10 w-10 text-vast-cyan" />
                  <div className="text-lg font-semibold text-white">Select a login</div>
                  <div className="mt-2 max-w-sm text-sm leading-6 text-vast-soft">Saved logins appear here after you add one or import a CSV file.</div>
                </div>
              </div>
            )}
          </div>
        </section>
        )}
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5 backdrop-blur-xl">
          <button type="button" aria-label="Close password form" className="absolute inset-0 cursor-default" onClick={() => setFormOpen(false)} />
          <div className="relative w-full max-w-2xl rounded-[28px] border border-white/10 bg-[#11131a]/95 p-5 shadow-glass">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-xl font-semibold">{editingId ? 'Edit login' : 'Add login'}</div>
                <div className="mt-1 text-sm text-vast-soft">Passwords are encrypted before they are written to disk.</div>
              </div>
              <button type="button" onClick={() => setFormOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl text-vast-soft hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-3">
              <VaultInput label="Title" value={form.title} onChange={(value) => setForm((state) => ({ ...state, title: value }))} placeholder="GitHub" testId="password-title-input" />
              <VaultInput label="Origin / URL" value={form.origin} onChange={(value) => setForm((state) => ({ ...state, origin: value }))} placeholder="https://github.com" testId="password-origin-input" />
              <VaultInput label="Username" value={form.username} onChange={(value) => setForm((state) => ({ ...state, username: value }))} placeholder="you@example.com" testId="password-username-input" />
              <div className="grid gap-2">
                <VaultInput label="Password" value={form.password} onChange={(value) => setForm((state) => ({ ...state, password: value }))} placeholder={editingId ? 'Leave blank to keep existing password' : 'Password'} type="password" testId="password-secret-input" />
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
                  <span className={passwordStrength(form.password).tone}>Strength: {passwordStrength(form.password).label}</span>
                  <button type="button" onClick={() => setForm((state) => ({ ...state, password: generatedPassword() }))} className="inline-flex items-center gap-1.5 font-semibold text-vast-cyan hover:text-white">
                    <Sparkles className="h-3.5 w-3.5" />
                    Generate 20 characters
                  </button>
                </div>
              </div>
              <div className="grid gap-2 text-sm font-semibold text-white">
                <span>Autofill on this domain</span>
                <VastSelect
                  value={form.autofillPolicy}
                  options={[
                    { value: 'ask', label: 'Ask before filling' },
                    { value: 'never', label: 'Never offer' }
                  ]}
                  onChange={(autofillPolicy) => setForm((state) => ({ ...state, autofillPolicy }))}
                  ariaLabel="Autofill on this domain"
                  buttonClassName="h-11 min-h-11 rounded-2xl"
                  align="start"
                />
              </div>
              <label className="grid gap-2 text-sm font-semibold text-white">
                Notes
                <textarea
                  value={form.notes}
                  onChange={(event) => setForm((state) => ({ ...state, notes: event.target.value }))}
                  placeholder="Optional notes"
                  className="min-h-24 resize-none rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm font-medium text-white outline-none placeholder:text-vast-soft focus:border-vast-cyan/40"
                  data-testid="password-notes"
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setFormOpen(false)} className="h-10 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-vast-soft hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveForm()}
                disabled={busy || !form.origin || (!editingId && !form.password)}
                className="h-10 rounded-2xl bg-vast-cyan px-4 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="password-save-button"
              >
                Save login
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/[0.075] bg-white/[0.04] p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-vast-soft">{label}</div>
      <div className="mt-2 truncate text-sm font-semibold text-white">{value}</div>
    </div>
  )
}

function VaultHealth({ label, value, detail }: { label: string; value: number; detail: string }): JSX.Element {
  return (
    <div className={`flex items-start gap-3 rounded-2xl border p-4 ${value > 0 ? 'border-vast-amber/25 bg-vast-amber/[0.08]' : 'border-vast-mint/20 bg-vast-mint/[0.06]'}`}>
      {value > 0 ? <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-vast-amber" /> : <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-vast-mint" />}
      <div>
        <div className="text-sm font-semibold text-white">{label}: {value}</div>
        <div className="mt-1 text-xs leading-5 text-vast-soft">{detail}</div>
      </div>
    </div>
  )
}

function VaultInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  testId
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  type?: string
  testId: string
}): JSX.Element {
  return (
    <label className="grid gap-2 text-sm font-semibold text-white">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 rounded-2xl border border-white/10 bg-black/20 px-3 text-sm font-medium text-white outline-none placeholder:text-vast-soft focus:border-vast-cyan/40"
        data-testid={testId}
      />
    </label>
  )
}
