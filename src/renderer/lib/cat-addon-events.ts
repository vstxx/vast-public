export const CAT_ADDON_EVENT = {
  omniboxFocus: 'vast:cat-addon:omnibox-focus',
  omniboxInput: 'vast:cat-addon:omnibox-input',
  omniboxBlur: 'vast:cat-addon:omnibox-blur',
  newTabButton: 'vast:cat-addon:new-tab-button',
  tabClosing: 'vast:cat-addon:tab-closing',
  previewScene: 'vast:cat-addon:preview-scene'
} as const

declare const __VAST_CAT_ADDON_AVAILABLE__: boolean

function enabled(): boolean {
  return document.documentElement.dataset.catAddonEnabled === 'true'
}

function dispatch(name: string, detail?: unknown): void {
  if (!enabled()) return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function notifyCatOmniboxInput(value: string): void {
  if (!__VAST_CAT_ADDON_AVAILABLE__) return
  dispatch(CAT_ADDON_EVENT.omniboxInput, { value })
}

export function notifyCatOmniboxFocus(): void {
  if (!__VAST_CAT_ADDON_AVAILABLE__) return
  dispatch(CAT_ADDON_EVENT.omniboxFocus)
}

export function notifyCatOmniboxBlur(): void {
  if (!__VAST_CAT_ADDON_AVAILABLE__) return
  dispatch(CAT_ADDON_EVENT.omniboxBlur)
}

export function notifyCatNewTabButton(): void {
  if (!__VAST_CAT_ADDON_AVAILABLE__) return
  dispatch(CAT_ADDON_EVENT.newTabButton)
}

export function notifyCatTabClosing(): void {
  if (!__VAST_CAT_ADDON_AVAILABLE__) return
  dispatch(CAT_ADDON_EVENT.tabClosing)
}
