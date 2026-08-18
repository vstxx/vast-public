import { useCallback } from 'react'
import { useBrowserStore } from '../../store/browser-store'

export function useVastConfirm(): (title: string, description?: string, confirmLabel?: string) => Promise<boolean> {
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  return useCallback((title, description, confirmLabel = 'Confirm') => new Promise<boolean>((resolve) => {
    openPromptDialog({
      title,
      description,
      label: '',
      hideInput: true,
      allowEmpty: true,
      confirmLabel,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false)
    })
  }), [openPromptDialog])
}
