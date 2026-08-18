export interface BookmarkBarLayoutInput {
  barWidth: number
  itemWidths: number[]
  padding?: number
  gap?: number
  moreButtonWidth?: number
}

export function calculateVisibleBookmarkCount({
  barWidth,
  itemWidths,
  padding = 24,
  gap = 4,
  moreButtonWidth = 76
}: BookmarkBarLayoutInput): number | null {
  if (itemWidths.length === 0) return 0
  if (barWidth <= padding || itemWidths.some((width) => width <= 0)) return null

  const contentWidth = barWidth - padding
  const naturalItemsWidth = itemWidths.reduce((total, width) => total + width, 0) + gap * Math.max(0, itemWidths.length - 1)
  if (naturalItemsWidth <= contentWidth) return itemWidths.length

  const availableForItems = contentWidth - moreButtonWidth - gap
  if (availableForItems <= 0) return 0

  let usedWidth = 0
  let count = 0

  for (let index = 0; index < itemWidths.length; index++) {
    const itemWidth = itemWidths[index] + (index > 0 ? gap : 0)
    if (usedWidth + itemWidth > availableForItems) break
    usedWidth += itemWidth
    count++
  }

  return count
}
