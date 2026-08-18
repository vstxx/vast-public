/// <reference types="vite/client" />

import type { VastApi } from '../shared/types'
import type React from 'react'

declare global {
  interface Window {
    vast: VastApi
  }

  namespace JSX {
    type Element = React.ReactElement
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<Electron.WebviewTag>, Electron.WebviewTag> & {
        src?: string
        partition?: string
        allowpopups?: boolean
        preload?: string
        webpreferences?: string
      }
    }
  }
}
