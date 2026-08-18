export type WindowBounds = { x: number; y: number; width: number; height: number }

export function clampWindowBounds(bounds: WindowBounds, workArea: WindowBounds, minWidth = 980, minHeight = 680): WindowBounds {
  const width = Math.min(workArea.width, Math.max(Math.min(minWidth, workArea.width), Math.round(bounds.width)))
  const height = Math.min(workArea.height, Math.max(Math.min(minHeight, workArea.height), Math.round(bounds.height)))
  const x = Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, Math.round(bounds.x)))
  const y = Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, Math.round(bounds.y)))
  return { x, y, width, height }
}
