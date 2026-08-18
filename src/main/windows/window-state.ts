import { app, screen, type BrowserWindow } from 'electron/main'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clampWindowBounds, type WindowBounds } from '../../shared/window-bounds'
import { atomicWriteJson } from '../atomic-file'
import type { VastWindowKind } from './WindowRegistry'

type SavedWindowState = WindowBounds & { maximized: boolean }
type SavedStates = Partial<Record<'main' | 'detached', SavedWindowState>>

function filePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function stateKey(kind: VastWindowKind): 'main' | 'detached' {
  return kind === 'detached' ? 'detached' : 'main'
}

function readStates(): SavedStates {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as SavedStates : {}
  } catch {
    return {}
  }
}

export function restoredWindowState(kind: VastWindowKind): SavedWindowState | undefined {
  const saved = readStates()[stateKey(kind)]
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return undefined
  const display = screen.getDisplayMatching(saved)
  return { ...clampWindowBounds(saved, display.workArea), maximized: saved.maximized === true }
}

export function persistWindowState(window: BrowserWindow, kind: VastWindowKind): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    if (window.isDestroyed()) return
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds()
    const states = readStates()
    states[stateKey(kind)] = { ...bounds, maximized: window.isMaximized() }
    void atomicWriteJson(filePath(), states).catch((error) => console.warn('[window-state] Save failed:', error))
  }
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, 250)
  }
  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.on('close', () => {
    clearTimeout(timer)
    save()
  })
}
