import { useEffect, useState } from 'react'
import { appearanceStyle } from '../../app/appearance-style'
import vastLogo from '../../../../assets/logos/vast.png'
import type { BrowserSettings } from '../../../shared/types'

type PreviewTheme = 'dark' | 'dim' | 'light'

function resolvePreviewTheme(theme: BrowserSettings['theme']): PreviewTheme {
  if (theme !== 'system') return theme
  if (typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * Live miniature of the Vast window, matching the approved Settings preview.
 * It renders from the same appearance derivation and CSS custom properties as
 * the real chrome, so every visual setting applied in Settings is reflected
 * immediately.
 */
export function AppearancePreview({ settings, layoutMode }: { settings: BrowserSettings; layoutMode: 'vertical' | 'horizontal' | 'purist' }): JSX.Element {
  const [systemLight, setSystemLight] = useState(() => resolvePreviewTheme(settings.theme) === 'light')

  useEffect(() => {
    if (settings.theme !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (event: MediaQueryListEvent): void => setSystemLight(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [settings.theme])

  const theme = settings.theme === 'system' ? (systemLight ? 'light' : 'dark') : settings.theme
  const previewClass = theme === 'light' ? 'light-theme' : theme === 'dim' ? 'dim-theme' : 'settings-preview-dark'

  return (
    <div
      className={`settings-preview ${previewClass} ${settings.appearance.cleanToolbarIcons ? 'clean-toolbar-icons' : ''}`}
      data-preview-layout={layoutMode}
      style={appearanceStyle(settings)}
      aria-hidden="true"
    >
      <div className="settings-preview-frame">
        <div className="pv-rail">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="pv-main">
          {layoutMode !== 'vertical' && (
            <div className="pv-tabs">
              {layoutMode === 'purist'
                ? <div className="pv-tab"><span className="pv-favicon" />vastbrowser.com</div>
                : <>
                  <div className="pv-tab"><span className="pv-favicon" />New tab<span className="pv-close">×</span></div>
                  <div className="pv-tab is-inactive"><span className="pv-favicon" />vastbrowser.com</div>
                </>}
            </div>
          )}
          <div className="pv-toolbar">
            <div className="pv-icon" />
            <div className="pv-icon" />
            <div className="pv-url" />
            <div className="pv-icon" />
          </div>
          <div className="pv-page" data-new-tab-background={settings.newTab.background}>
            <div className="pv-mark"><span className="pv-logo-frame"><img src={vastLogo} alt="" draggable={false} decoding="async" className="pv-logo" /></span></div>
            <div className="pv-search" />
          </div>
        </div>
      </div>
    </div>
  )
}
