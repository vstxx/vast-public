type BrowserFullscreenInput = Pick<Electron.Input, 'type' | 'code' | 'control' | 'meta' | 'alt' | 'shift'>

export function isBrowserFullscreenInput(input: BrowserFullscreenInput): boolean {
  return input.type === 'keyDown' && input.code === 'F11' && !input.control && !input.meta && !input.alt && !input.shift
}
