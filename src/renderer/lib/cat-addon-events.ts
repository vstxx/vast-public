export const CAT_ADDON_EVENT = {
  omniboxFocus: 'vast:cat-addon:omnibox-focus',
  omniboxInput: 'vast:cat-addon:omnibox-input',
  omniboxBlur: 'vast:cat-addon:omnibox-blur',
  newTabButton: 'vast:cat-addon:new-tab-button',
  tabClosing: 'vast:cat-addon:tab-closing',
  previewScene: 'vast:cat-addon:preview-scene'
} as const

function enabled(): boolean {
  return document.documentElement.dataset.catAddonEnabled === 'true'
}

function dispatch(name: string, detail?: unknown): void {
  if (!enabled()) return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function notifyCatOmniboxInput(value: string): void {
  dispatch(CAT_ADDON_EVENT.omniboxInput, { value })
}

export function notifyCatOmniboxFocus(): void {
  dispatch(CAT_ADDON_EVENT.omniboxFocus)
}

export function notifyCatOmniboxBlur(): void {
  dispatch(CAT_ADDON_EVENT.omniboxBlur)
}

export function notifyCatNewTabButton(): void {
  dispatch(CAT_ADDON_EVENT.newTabButton)
}

export function notifyCatTabClosing(): void {
  dispatch(CAT_ADDON_EVENT.tabClosing)
}
