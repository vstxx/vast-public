import type { LayoutMode } from './types'

export function resolveLayoutMode(layoutMode: LayoutMode, experimentalFeatures: boolean): LayoutMode {
  return layoutMode === 'purist' && !experimentalFeatures ? 'horizontal' : layoutMode
}
