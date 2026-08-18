import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WindowFrameState } from '../../../shared/types'

const RESTORED_WINDOW_STATE: WindowFrameState = { maximized: false, fullscreen: false }

export function WindowControls({ placement = 'chrome' }: { placement?: 'chrome' | 'overlay' }): JSX.Element | null {
  const [state, setState] = useState<WindowFrameState>(RESTORED_WINDOW_STATE)

  useEffect(() => {
    if (window.vast.app.platform !== 'win32') return undefined
    let active = true
    void window.vast.app.window.state().then((next) => {
      if (active) setState(next)
    }).catch(() => undefined)
    const unsubscribe = window.vast.app.window.onStateChanged((next) => setState(next))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  if (window.vast.app.platform !== 'win32') return null
  const restored = state.maximized || state.fullscreen

  return (
    <div
      className={`vast-window-controls no-drag flex shrink-0 items-center ${placement === 'overlay' ? 'is-overlay' : ''}`}
      role="group"
      aria-label="Window controls"
    >
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize window"
        onClick={() => void window.vast.app.window.minimize()}
        className="vast-window-control"
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={1.6} />
      </button>
      <button
        type="button"
        title={restored ? 'Restore' : 'Maximize'}
        aria-label={restored ? 'Restore window' : 'Maximize window'}
        onClick={() => void window.vast.app.window.toggleMaximize()}
        className="vast-window-control"
      >
        {restored
          ? <Copy className="h-3 w-3 -scale-x-100" strokeWidth={1.55} />
          : <Square className="h-3 w-3" strokeWidth={1.55} />}
      </button>
      <button
        type="button"
        title="Close"
        aria-label="Close window"
        onClick={() => void window.vast.app.window.close()}
        className="vast-window-control is-close"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.6} />
      </button>
    </div>
  )
}
