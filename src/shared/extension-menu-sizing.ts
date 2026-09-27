export interface ExtensionMenuSize {
  width: number
  height: number
}

export interface ExtensionMenuViewport {
  width: number
  height: number
}

export type ExtensionMenuResizeAxis = 'width' | 'height' | 'both'

export const EXTENSION_MENU_MIN_WIDTH = 320
export const EXTENSION_MENU_MAX_WIDTH = 720
export const EXTENSION_MENU_MIN_HEIGHT = 280
export const EXTENSION_MENU_MAX_HEIGHT = 1_200
export const EXTENSION_MENU_EDGE_GAP = 8

function finiteDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

export function sanitizeStoredExtensionMenuSize(size: Partial<ExtensionMenuSize> | undefined): ExtensionMenuSize {
  return {
    width: Math.min(EXTENSION_MENU_MAX_WIDTH, Math.max(EXTENSION_MENU_MIN_WIDTH, finiteDimension(size?.width, 368))),
    height: Math.min(EXTENSION_MENU_MAX_HEIGHT, Math.max(EXTENSION_MENU_MIN_HEIGHT, finiteDimension(size?.height, 452)))
  }
}

export function clampExtensionMenuSize(
  size: ExtensionMenuSize,
  viewport: ExtensionMenuViewport,
  top: number
): ExtensionMenuSize {
  const stored = sanitizeStoredExtensionMenuSize(size)
  const availableWidth = Math.max(160, Math.round(viewport.width) - EXTENSION_MENU_EDGE_GAP * 2)
  const availableHeight = Math.max(160, Math.round(viewport.height) - Math.max(0, Math.round(top)) - EXTENSION_MENU_EDGE_GAP)
  return {
    width: Math.min(stored.width, availableWidth),
    height: Math.min(stored.height, availableHeight)
  }
}

export function resizeExtensionMenu(
  start: ExtensionMenuSize,
  axis: ExtensionMenuResizeAxis,
  delta: { x: number; y: number },
  viewport: ExtensionMenuViewport,
  top: number
): ExtensionMenuSize {
  return clampExtensionMenuSize({
    width: axis === 'height' ? start.width : start.width - delta.x,
    height: axis === 'width' ? start.height : start.height + delta.y
  }, viewport, top)
}
