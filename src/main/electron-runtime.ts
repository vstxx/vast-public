import { app, type BrowserWindow } from 'electron/main'

export const isDev = !app.isPackaged

export function setAppUserModelId(id: string): void {
  if (process.platform === 'win32') app.setAppUserModelId(id)
}

export function watchWindowShortcuts(window: BrowserWindow): void {
  const { webContents } = window
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    if (isDev && input.code === 'F12') {
      if (webContents.isDevToolsOpened()) webContents.closeDevTools()
      else webContents.openDevTools({ mode: 'undocked' })
      return
    }

    if (!isDev) {
      if (input.code === 'KeyR' && (input.control || input.meta)) event.preventDefault()
      if (input.code === 'KeyI' && ((input.alt && input.meta) || (input.control && input.shift))) event.preventDefault()
    }

    if (input.code === 'Minus' && (input.control || input.meta)) event.preventDefault()
    if (input.code === 'Equal' && input.shift && (input.control || input.meta)) event.preventDefault()
  })
}
