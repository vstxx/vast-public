export interface CatAnchor {
  left: number
  top: number
  width: number
  height: number
}

export const CAT_SCENE_SCALE = 2.5
export const CAT_SCENE_SIZE = 32 * CAT_SCENE_SCALE

const TOP_MARGIN = 6
const VISIBLE_FOOT_MARGIN = 8

export function clampCatY(y: number, viewportHeight: number, spriteSize = CAT_SCENE_SIZE): number {
  const maximum = Math.max(TOP_MARGIN, viewportHeight - spriteSize + VISIBLE_FOOT_MARGIN)
  return Math.max(TOP_MARGIN, Math.min(maximum, y))
}

export function isHorizontalCatRail(anchor: CatAnchor): boolean {
  return anchor.top < 110 && anchor.height <= 96 && anchor.width > anchor.height * 3
}

/** Places a full sprite just below a chrome control while retaining a small visual overlap. */
export function catChromeY(anchor: CatAnchor, viewportHeight: number, overlap = 28): number {
  return clampCatY(anchor.top + anchor.height - overlap, viewportHeight)
}

/** Uses the tab strip as a perch in horizontal mode and the middle of the rail in vertical mode. */
export function catRailY(anchor: CatAnchor, viewportHeight: number): number {
  if (isHorizontalCatRail(anchor)) return catChromeY(anchor, viewportHeight, 28)
  const railOffset = Math.min(Math.max(96, anchor.height * 0.48), Math.max(96, anchor.height - 88))
  return clampCatY(anchor.top + railOffset, viewportHeight)
}

export function catBottomY(viewportHeight: number): number {
  return clampCatY(viewportHeight - CAT_SCENE_SIZE + VISIBLE_FOOT_MARGIN, viewportHeight)
}

export function catClimbStartY(perchY: number, viewportHeight: number): number {
  return clampCatY(perchY + 96, viewportHeight)
}
