export type MouseNavigationAction = 'back' | 'forward'

export function mouseNavigationActionForButton(button: number): MouseNavigationAction | undefined {
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return undefined
}

export function shouldTriggerMouseNavigation(eventType: string): boolean {
  return eventType === 'mouseup' || eventType === 'auxclick'
}
