import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBrowserStore } from '../../store/browser-store'
import { ModalShell } from './ModalShell'
import { VastButton } from './VastButton'

export function PromptDialog(): JSX.Element | null {
  const dialog = useBrowserStore((state) => state.promptDialog)
  const close = useBrowserStore((state) => state.closePromptDialog)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue(dialog?.defaultValue ?? '')
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [dialog])

  if (!dialog) return null
  const cancel = (): void => {
    dialog.onCancel?.()
    close()
  }

  const trimmed = value.trim()
  const canSubmit = dialog.allowEmpty ? true : !!trimmed

  return (
    <ModalShell onClose={cancel} width="max-w-md">
      <form
        className="p-5"
        onKeyDown={(event) => {
          if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSubmit) return
          dialog.onConfirm(trimmed)
          close()
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-white">{dialog.title}</div>
            {dialog.description && <div className="mt-1 text-sm leading-6 text-vast-soft">{dialog.description}</div>}
          </div>
          <button
            type="button"
            onClick={cancel}
            className="vast-icon-button vast-icon-button--quiet grid place-items-center h-9 w-9 shrink-0 rounded-control"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!dialog.hideInput && <label className="mt-5 block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-vast-soft">{dialog.label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={(event) => {
              const dialogElement = event.currentTarget.closest('[role="dialog"]')
              const nextTarget = event.relatedTarget
              if (nextTarget instanceof Node && dialogElement?.contains(nextTarget)) return
              window.requestAnimationFrame(() => {
                if (useBrowserStore.getState().promptDialog === dialog) inputRef.current?.focus()
              })
            }}
            placeholder={dialog.placeholder}
            className="mt-2 h-12 w-full rounded-card border border-white/10 bg-black/25 px-4 text-sm font-medium text-white outline-hidden transition focus:border-vast-cyan/40 focus:bg-black/35"
          />
        </label>}

        <div className="mt-5 flex justify-end gap-2">
          <VastButton variant="secondary" onClick={cancel}>
            Cancel
          </VastButton>
          <VastButton type="submit" variant="primary" disabled={!canSubmit}>
            {dialog.confirmLabel ?? 'Create'}
          </VastButton>
        </div>
      </form>
    </ModalShell>
  )
}
