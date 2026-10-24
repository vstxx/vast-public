import { useCallback } from 'react'
import { useBrowserStore } from '../../store/browser-store'

export function useVastConfirm(): (title: string, description?: string, confirmLabel?: string, options?: { danger?: boolean }) => Promise<boolean> {
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  return useCallback((title, description, confirmLabel = 'Confirm', options) => new Promise<boolean>((resolve) => {
    openPromptDialog({
      title,
      description,
      label: '',
      hideInput: true,
      allowEmpty: true,
      confirmLabel,
      danger: options?.danger,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false)
    })
  }), [openPromptDialog])
}
