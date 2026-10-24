import { MoreHorizontal } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  DEFAULT_VISUAL_PROFILE_VALUES,
  effectiveVisualProfileValues,
  normalizeVisualProfileName,
  sameVisualProfileValues,
  uniqueVisualProfileName,
  visualProfileSettingsPatch,
  visualProfileValuesFromSettings,
  type VisualProfileValues
} from '../../../shared/visual-profile'
import type { VisualProfileListing, VisualProfileResult, VisualProfileSummary } from '../../../shared/types'
import { useBrowserStore } from '../../store/browser-store'
import { IconButton } from '../ui/IconButton'
import { VastButton } from '../ui/VastButton'
import { VastMenuItem } from '../ui/VastMenuItem'
import { useVastConfirm } from '../ui/useVastConfirm'

const DEFAULT_ROW = 'default'
const themeLabels: Record<VisualProfileValues['theme'], string> = { dark: 'Dark', dim: 'Dim', light: 'Light', system: 'System' }
const layoutLabels: Record<VisualProfileValues['layoutMode'], string> = { vertical: 'Vertical', horizontal: 'Horizontal', purist: 'Purist' }

interface UndoState {
  /** The look that was applied; Undo is offered only while it is unchanged. */
  target: VisualProfileValues
  values: VisualProfileValues
  appliedId: string | null
  imageSwapped: boolean
}

interface Status {
  message: string
  error?: boolean
  undo?: UndoState
}

interface ApplyTarget {
  id: string | null
  name: string
  values: VisualProfileValues
  hasImage: boolean
}

type ListingResult = VisualProfileResult | { ok: false; error: string }

// Tells Settings and open New Tab pages the stored image changed (null: removed).
function announceBackground(dataUrl: string | null): void {
  window.dispatchEvent(new CustomEvent('vast-new-tab-background-changed', { detail: dataUrl }))
}

function describe(values: VisualProfileValues, hasImage: boolean): string {
  return [themeLabels[values.theme], layoutLabels[values.layoutMode], hasImage ? 'Custom image' : ''].filter(Boolean).join(' · ')
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function Swatch({ values }: { values: VisualProfileValues }): JSX.Element {
  return (
    <span className="visual-profile-swatch" aria-hidden="true">
      <span style={{ background: values.accentColor }} />
      <span style={{ background: values.secondaryAccentColor }} />
      <span style={{ background: values.surfaceTintColor }} />
    </span>
  )
}

function ProfileMenu({ name, onClose, actions }: { name: string; onClose: (refocus: boolean) => void; actions: Array<{ label: string; danger?: boolean; run: () => void }> }): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; right: number }>()

  // Placed against the card below its trigger, outside the scrolling list.
  useLayoutEffect(() => {
    const trigger = menuRef.current?.parentElement?.querySelector('button')
    const card = menuRef.current?.closest('.visual-profiles')
    if (!trigger || !card) return
    const anchor = trigger.getBoundingClientRect()
    const bounds = card.getBoundingClientRect()
    setPosition({ top: anchor.bottom - bounds.top + 5, right: bounds.right - anchor.right })
  }, [])

  useEffect(() => {
    if (!position) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [position])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.parentElement?.contains(event.target as Node)) onClose(false)
    }
    // The menu does not follow its row, so scrolling the list closes it.
    const list = menuRef.current?.closest('.visual-profile-list')
    const onScroll = (): void => onClose(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    list?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      list?.removeEventListener('scroll', onScroll)
    }
  }, [onClose])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      // Close the menu only; Settings keeps its own Escape behavior.
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${name} actions`}
      className="visual-profile-menu vast-float rounded-card border border-white/10 p-1 text-sm text-white shadow-glass"
      style={position ?? { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {actions.map((action) => (
        <VastMenuItem key={action.label} danger={action.danger} onClick={() => { onClose(true); action.run() }}>
          {action.label}
        </VastMenuItem>
      ))}
    </div>
  )
}

/**
 * Settings > Appearance: save, switch, import and export the Appearance page.
 * The library loads when Settings opens; applying is one settings update.
 */
export function VisualProfilesCard(): JSX.Element {
  const settings = useBrowserStore((state) => state.settings)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const confirm = useVastConfirm()
  const [listing, setListing] = useState<VisualProfileListing>({ profiles: [], appliedId: null })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const focusRow = useRef<string | null>(null)
  const mounted = useRef(true)

  const experimental = settings.advanced.experimentalFeatures
  const current = useMemo(() => visualProfileValuesFromSettings(settings), [settings])
  const matches = useCallback(
    (values: VisualProfileValues) => sameVisualProfileValues(effectiveVisualProfileValues(values, experimental), current),
    [current, experimental]
  )

  useEffect(() => {
    mounted.current = true
    void window.vast.visualProfiles.list().then((result) => {
      if (mounted.current && result.ok) setListing({ profiles: result.profiles, appliedId: result.appliedId })
    })
    return () => { mounted.current = false }
  }, [])

  const showListing = (result: VisualProfileListing): VisualProfileListing => {
    const next = { profiles: result.profiles, appliedId: result.appliedId }
    setListing(next)
    return next
  }

  // Buttons swap out as state changes (Apply becomes Applied). After the
  // render that removes them, keep keyboard focus in the row acted on.
  useEffect(() => {
    const row = focusRow.current
    if (!row || busy) return
    focusRow.current = null
    const card = cardRef.current
    if (!card || useBrowserStore.getState().promptDialog) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const target = card.querySelector<HTMLElement>(`[data-row="${row}"] .visual-profile-controls button`) ?? card.querySelector<HTMLElement>('.visual-profiles-actions button:last-child')
    target?.focus()
  })

  /** One action at a time; controls stay enabled so they keep focus. */
  const exclusive = async (row: string, task: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await task()
    } catch (error) {
      if (mounted.current) setStatus({ message: errorMessage(error, 'Something went wrong.'), error: true })
    } finally {
      busyRef.current = false
      if (mounted.current) {
        focusRow.current = row
        setBusy(false)
      }
    }
  }

  const library = (row: string, action: () => Promise<ListingResult | undefined>, success?: (next: VisualProfileListing) => Status | null) => exclusive(row, async () => {
    const result = await action()
    if (!mounted.current || !result) return
    if (!result.ok) {
      setStatus({ message: result.error, error: true })
      return
    }
    const next = showListing(result)
    setStatus(success ? success(next) : null)
  })

  const askName = (title: string, confirmLabel: string, defaultValue: string): Promise<string | null> => new Promise((resolve) => {
    openPromptDialog({
      title,
      label: 'Name',
      defaultValue,
      confirmLabel,
      onConfirm: (value) => {
        try {
          resolve(normalizeVisualProfileName(value))
        } catch (error) {
          setStatus({ message: errorMessage(error, 'Enter a profile name.'), error: true })
          resolve(null)
        }
      },
      onCancel: () => resolve(null)
    })
  })

  const saveCurrent = (): Promise<void> => library('save', async () => {
    const name = await askName('Save visual profile', 'Save', uniqueVisualProfileName('Visual profile', listing.profiles.map((profile) => profile.name)))
    return name ? window.vast.visualProfiles.save(name, current) : undefined
  }, (next) => ({ message: `Saved “${next.profiles.find((profile) => profile.id === next.appliedId)?.name ?? 'profile'}”.` }))

  const apply = (target: ApplyTarget): Promise<void> => exclusive(target.id ?? DEFAULT_ROW, async () => {
    const undo: UndoState = { target: target.values, values: current, appliedId: listing.appliedId, imageSwapped: false }
    try {
      // The image goes first: if it fails, nothing has changed yet.
      if (target.hasImage && target.id) {
        const image = await window.vast.visualProfiles.applyImage(target.id)
        if (!image.ok) throw new Error(image.error)
        undo.imageSwapped = true
        announceBackground(image.dataUrl)
      }
      updateSettings(visualProfileSettingsPatch(target.values))
    } catch (error) {
      if (undo.imageSwapped) {
        const restored = await window.vast.visualProfiles.restoreImage().catch(() => null)
        if (restored?.ok) announceBackground(restored.dataUrl ?? null)
      }
      throw new Error(errorMessage(error, 'The profile could not be applied.'))
    }
    const result = await window.vast.visualProfiles.setApplied(target.id)
    if (!mounted.current) return
    if (result.ok) showListing(result)
    const fallback = target.values.layoutMode === 'purist' && !experimental ? ' Purist needs experimental features in Labs, so Horizontal is used.' : ''
    setStatus({ message: `Applied “${target.name}”.${fallback}`, undo })
  })

  const undoApply = (undo: UndoState): Promise<void> => exclusive(listing.appliedId ?? DEFAULT_ROW, async () => {
    if (undo.imageSwapped) {
      const restored = await window.vast.visualProfiles.restoreImage()
      if (!restored.ok) throw new Error(restored.error)
      announceBackground(restored.dataUrl ?? null)
    }
    updateSettings(visualProfileSettingsPatch(undo.values))
    const stillThere = undo.appliedId && listing.profiles.some((profile) => profile.id === undo.appliedId) ? undo.appliedId : null
    const result = await window.vast.visualProfiles.setApplied(stillThere)
    if (!mounted.current) return
    if (result.ok) showListing(result)
    setStatus({ message: 'Restored your previous appearance.' })
  })

  const update = (profile: VisualProfileSummary): Promise<void> =>
    library(profile.id, () => window.vast.visualProfiles.update(profile.id, current), () => ({ message: `Updated “${profile.name}”.` }))

  // Overwriting a profile that is not the applied one replaces a different look.
  const replaceWithCurrent = (profile: VisualProfileSummary): Promise<void> => library(profile.id, async () => {
    if (!await confirm(`Replace “${profile.name}”?`, 'It will be saved with your current appearance instead.', 'Replace')) return undefined
    return window.vast.visualProfiles.update(profile.id, current)
  }, () => ({ message: `Updated “${profile.name}”.` }))

  const rename = (profile: VisualProfileSummary): Promise<void> => library(profile.id, async () => {
    const name = await askName('Rename visual profile', 'Rename', profile.name)
    return name && name !== profile.name ? window.vast.visualProfiles.rename(profile.id, name) : undefined
  })

  const remove = (profile: VisualProfileSummary): Promise<void> => library('save', async () => {
    if (!await confirm(`Delete “${profile.name}”?`, 'This removes the saved profile. Your current appearance stays as it is.', 'Delete', { danger: true })) return undefined
    return window.vast.visualProfiles.remove(profile.id)
  }, () => ({ message: `Deleted “${profile.name}”.` }))

  const exportProfile = (profile: VisualProfileSummary): Promise<void> => exclusive(profile.id, async () => {
    const result = await window.vast.visualProfiles.exportProfile(profile.id)
    if (!mounted.current) return
    if (!result.ok) setStatus({ message: result.error, error: true })
    else if (!result.canceled) setStatus({ message: `Exported “${profile.name}”.` })
  })

  const importProfile = (): Promise<void> => library('save', async () => {
    const result = await window.vast.visualProfiles.importProfile()
    return result.ok && result.canceled ? undefined : result
  }, (next) => {
    const imported = next.profiles.at(-1)
    return { message: imported ? `Imported “${imported.name}”. Apply it to use it.` : 'Imported.' }
  })

  const closeMenu = useCallback((refocus: boolean) => {
    if (refocus && menuFor) cardRef.current?.querySelector<HTMLElement>(`[data-profile-menu="${menuFor}"]`)?.focus()
    setMenuFor(null)
  }, [menuFor])

  const appliedProfile = listing.profiles.find((profile) => profile.id === listing.appliedId)
  const defaultApplied = !appliedProfile && matches(DEFAULT_VISUAL_PROFILE_VALUES)
  const busyProps = { 'aria-disabled': busy || undefined }

  return (
    <div ref={cardRef} className="settings-card visual-profiles" aria-busy={busy || undefined}>
      <div className="visual-profiles-head">
        <h3 className="settings-card-title">Visual profiles</h3>
        <div className="visual-profiles-actions">
          <VastButton variant="quiet" size="xs" {...busyProps} onClick={() => void importProfile()}>Import</VastButton>
          <VastButton variant="secondary" size="xs" {...busyProps} onClick={() => void saveCurrent()}>Save current</VastButton>
        </div>
      </div>
      <ul className="visual-profile-list" aria-label="Visual profiles">
        <li className="visual-profile-row" data-row={DEFAULT_ROW}>
          <Swatch values={DEFAULT_VISUAL_PROFILE_VALUES} />
          <span className="visual-profile-text">
            <span className="visual-profile-name">Vast default</span>
            <span className="visual-profile-sub">Built in</span>
          </span>
          <span className="visual-profile-controls">
            {defaultApplied
              ? <span className="visual-profile-state">Applied</span>
              : <VastButton variant="secondary" size="xs" {...busyProps} onClick={() => void apply({ id: null, name: 'Vast default', values: DEFAULT_VISUAL_PROFILE_VALUES, hasImage: false })}>Apply</VastButton>}
            <span className="visual-profile-menu-slot" aria-hidden="true" />
          </span>
        </li>
        {listing.profiles.map((profile) => {
          const isApplied = profile.id === listing.appliedId
          const unchanged = matches(profile.values)
          const changed = isApplied && !unchanged
          const target = { id: profile.id, name: profile.name, values: profile.values, hasImage: profile.hasImage }
          return (
            <li key={profile.id} className="visual-profile-row" data-row={profile.id}>
              <Swatch values={profile.values} />
              <span className="visual-profile-text">
                <span className="visual-profile-name" title={profile.name}>{profile.name}</span>
                <span className="visual-profile-sub">{changed ? 'Unsaved changes' : describe(profile.values, profile.hasImage)}</span>
              </span>
              <span className="visual-profile-controls">
                {isApplied && unchanged
                  ? <span className="visual-profile-state">Applied</span>
                  : changed
                    ? <VastButton variant="secondary" size="xs" {...busyProps} onClick={() => void update(profile)}>Update</VastButton>
                    : <VastButton variant="secondary" size="xs" {...busyProps} onClick={() => void apply(target)}>Apply</VastButton>}
                <span className="visual-profile-menu-slot">
                  <IconButton
                    size="xs"
                    variant="quiet"
                    tooltip="More"
                    aria-label={`More actions for ${profile.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === profile.id}
                    {...busyProps}
                    data-profile-menu={profile.id}
                    onClick={() => { if (!busyRef.current) setMenuFor((open) => (open === profile.id ? null : profile.id)) }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </IconButton>
                  {menuFor === profile.id && (
                    <ProfileMenu
                      name={profile.name}
                      onClose={closeMenu}
                      actions={[
                        ...(changed ? [{ label: 'Revert changes', run: () => void apply(target) }] : []),
                        ...(!isApplied ? [{ label: 'Update with current look', run: () => void replaceWithCurrent(profile) }] : []),
                        { label: 'Rename', run: () => void rename(profile) },
                        { label: 'Export', run: () => void exportProfile(profile) },
                        { label: 'Delete', danger: true, run: () => void remove(profile) }
                      ]}
                    />
                  )}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      {/* Always present: keeps the list height steady and the live region ready. */}
      <div className={`visual-profiles-status${status?.error ? ' is-error' : ''}`} role={status?.error ? 'alert' : 'status'}>
        {status && <span>{status.message}</span>}
        {status?.undo && matches(status.undo.target) && (
          <VastButton variant="quiet" size="xs" {...busyProps} onClick={() => void undoApply(status.undo!)}>Undo</VastButton>
        )}
      </div>
    </div>
  )
}
