let activeDrag: { tabId: string; droppedOnTab: boolean } | undefined

export function beginTabDrag(tabId: string, dataTransfer: DataTransfer): void {
  activeDrag = { tabId, droppedOnTab: false }
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData('text/plain', tabId)
}

export function recordTabDrop(tabId: string): void {
  if (activeDrag?.tabId === tabId) activeDrag.droppedOnTab = true
}

export function consumeTabDrop(tabId: string): boolean {
  if (activeDrag?.tabId !== tabId) return false
  const droppedOnTab = activeDrag.droppedOnTab
  activeDrag = undefined
  return droppedOnTab
}
