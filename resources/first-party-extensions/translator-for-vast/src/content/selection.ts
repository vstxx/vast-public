// The selection popup. It lives in a closed shadow root on its own host element, styled with a
// constructed stylesheet (not subject to the page's style-src), so page CSS cannot reach in and
// page scripts cannot reach its controls. Actions require trusted user events.

import { languageName, sortByName } from '../shared/languages.ts'
import { formatBytes, t, uiLanguage } from '../shared/i18n.ts'
import { LIMITS, errorMessage, type RouteStatus } from '../shared/protocol.ts'
import { escapeHtml } from '../shared/text.ts'
import { plainText } from './renderer.ts'
import { send, UI_HOST_TAG } from './page.ts'

const STYLE = `
:host{all:initial;position:fixed;z-index:2147483647;top:0;left:0;contain:layout style}
*{box-sizing:border-box}
.box{width:min(360px,calc(100vw - 16px));max-height:min(360px,calc(100vh - 16px));display:flex;flex-direction:column;
  font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f5f7fb;background:#0d0d0f;
  border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.34);overflow:hidden;
  opacity:0;transform:translateY(4px);transition:opacity .12s ease-out,transform .12s ease-out;outline:none}
.box.open{opacity:1;transform:none}
header{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.title{font-weight:600;font-size:12px;color:#b4bbc8;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
select,button{font:inherit;font-size:12px;color:inherit;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);border-radius:8px;height:28px;padding:0 8px;cursor:pointer}
select{max-width:150px}
select option{background:#151517;color:#f5f7fb}
button:hover,select:hover{background:rgba(255,255,255,.09)}
button:focus-visible,select:focus-visible,.box:focus-visible{outline:2px solid rgba(255,255,255,.55);outline-offset:1px}
.close{width:28px;padding:0;display:grid;place-items:center;border-color:transparent;background:transparent}
.close svg{width:14px;height:14px}
.body{padding:10px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.55}
.body.muted{color:#b4bbc8;font-size:13px}
.body.error{color:#ffb4b9;font-size:13px}
footer{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid rgba(255,255,255,.08);color:#929aaa;font-size:12px}
footer .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
footer:empty{display:none}
.primary{background:#f5f7fb;color:#111;border-color:transparent;font-weight:600}
.primary:hover{background:#fff}
.bar{height:3px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;width:40%;background:#f5f7fb;border-radius:3px;animation:slide 1.1s ease-in-out infinite}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media (prefers-color-scheme: light){
  .box{color:#141414;background:#fff;border-color:rgba(0,0,0,.14);box-shadow:0 14px 40px rgba(0,0,0,.16)}
  header,footer{border-color:rgba(0,0,0,.08)}
  .title,.body.muted{color:#4b5260}
  footer{color:#5c6371}
  .body.error{color:#b3261e}
  select,button{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.12)}
  select option{background:#fff;color:#141414}
  button:hover,select:hover{background:rgba(0,0,0,.08)}
  .close{background:transparent;border-color:transparent}
  .primary{background:#141414;color:#fff}
  .primary:hover{background:#000}
  .bar{background:rgba(0,0,0,.08)}.bar>i{background:#141414}
  button:focus-visible,select:focus-visible,.box:focus-visible{outline-color:rgba(0,0,0,.6)}
}
@media (prefers-reduced-motion: reduce){.box{transition:none}.bar>i{animation:none;width:100%}}
`

const CLOSE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

let sheet: CSSStyleSheet | null = null

interface Anchor {
  range: Range | null
  fallback: DOMRect
}

export class SelectionPopup {
  private host: HTMLElement | null = null
  private box: HTMLElement | null = null
  private body: HTMLElement | null = null
  private footer: HTMLElement | null = null
  private select: HTMLSelectElement | null = null
  private anchor: Anchor | null = null
  private token = 0
  private frame = 0
  private returnFocus: Element | null = null
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.host) {
      event.stopPropagation()
      this.close()
    }
  }
  private readonly onScroll = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.place()
    })
  }
  private readonly onPointer = (event: PointerEvent) => {
    if (this.host && !event.composedPath().includes(this.host)) this.close()
  }

  async show(commandText: string, target: string, targets: string[]): Promise<void> {
    const selection = getSelection()
    const live = selection && selection.rangeCount > 0 ? selection.toString() : ''
    // The page's own selection keeps line breaks; the menu's copy is the fallback (another frame).
    let text = (live.trim() ? live : commandText).trim()
    const range = selection && selection.rangeCount > 0 && live.trim() ? selection.getRangeAt(0).cloneRange() : null
    this.open({ range, fallback: new DOMRect(innerWidth / 2 - 180, 24, 0, 0) }, targets, target)
    if (!text) {
      this.message(t('selectionNothing'), 'muted')
      return
    }
    let truncated = false
    if (text.length > LIMITS.selectionChars) {
      text = text.slice(0, LIMITS.selectionChars)
      truncated = true
    }
    await this.translate(text, target, truncated)
  }

  private async translate(text: string, target: string, truncated: boolean): Promise<void> {
    const token = ++this.token
    this.lastText = text
    this.message(t('selectionTranslating'), 'muted', true)
    this.setFooter([])
    try {
      const detected = await send<{ language: string | null }>({ type: 'content:detect', sample: text.slice(0, LIMITS.sampleChars), declared: document.documentElement.getAttribute('lang') })
      if (token !== this.token) return
      const source = detected.language
      if (!source) {
        this.message(t('unknownLanguage'), 'muted')
        return
      }
      if (source === target) {
        this.message(t('selectionSame', { language: languageName(target, uiLanguage()) }), 'muted')
        return
      }
      const route = await send<RouteStatus>({ type: 'content:route', source, target })
      if (token !== this.token) return
      if (!route.available) {
        this.message(t('noRoute', { source: languageName(source, uiLanguage()), target: languageName(target, uiLanguage()) }), 'muted')
        return
      }
      if (!route.installed) {
        this.offerDownload(text, source, target, route, truncated)
        return
      }
      const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).slice(0, LIMITS.fragments)
      const reply = await send<{ fragments: string[] }>({ type: 'content:translate', source, target, fragments: paragraphs.map(escapeHtml), priority: 'selection' })
      if (token !== this.token) return
      const result = reply.fragments.map((fragment) => plainText(fragment).trim()).join('\n\n')
      this.message(result, 'result')
      const language = languageName(source, uiLanguage())
      const notes = [`${language} → ${languageName(target, uiLanguage())}`]
      if (truncated) notes.push(t('selectionTruncated', { count: LIMITS.selectionChars }))
      this.setFooter([this.note(notes.join(' · ')), this.button(t('copy'), () => void this.copy(result))])
    } catch (error) {
      if (token === this.token) this.message(t('errorGeneric', { error: errorMessage(error) }), 'error')
    }
  }

  // The page menu asked for a translation whose model is missing: offer it here, then translate.
  async offerPage(source: string, target: string, targets: string[], translatePage: () => Promise<unknown>): Promise<void> {
    this.open({ range: null, fallback: new DOMRect(innerWidth - 376, 16, 0, 0) }, targets, target)
    if (this.select) this.select.disabled = true
    const token = ++this.token
    const route = await send<RouteStatus>({ type: 'content:route', source, target }).catch(() => null)
    if (token !== this.token || !route) return
    const names = { source: languageName(source, uiLanguage()), target: languageName(target, uiLanguage()) }
    this.message(`${t('downloadNeeded', names)}${route.pivot ? `\n${t('downloadPivot')}` : ''}`, 'muted')
    this.setFooter([this.note(''), this.button(t('downloadAction', { size: formatBytes(route.downloadBytes) }), async () => {
      const current = ++this.token
      this.message(t('downloading', { loaded: '…', total: formatBytes(route.downloadBytes) }), 'muted', true)
      this.setFooter([])
      try {
        await send({ type: 'content:download', source, target })
        if (current !== this.token) return
        this.close()
        await translatePage()
      } catch (error) {
        if (current === this.token) this.message(t('downloadFailed', { error: errorMessage(error) }), 'error')
      }
    }, true)])
  }

  private offerDownload(text: string, source: string, target: string, route: RouteStatus, truncated: boolean): void {
    const names = { source: languageName(source, uiLanguage()), target: languageName(target, uiLanguage()) }
    this.message(`${t('downloadNeeded', names)}${route.pivot ? `\n${t('downloadPivot')}` : ''}`, 'muted')
    const download = this.button(t('downloadAction', { size: formatBytes(route.downloadBytes) }), async () => {
      const token = ++this.token
      this.message(t('downloading', { loaded: '…', total: formatBytes(route.downloadBytes) }), 'muted', true)
      this.setFooter([])
      try {
        await send({ type: 'content:download', source, target })
        if (token === this.token) await this.translate(text, target, truncated)
      } catch (error) {
        if (token === this.token) this.message(t('downloadFailed', { error: errorMessage(error) }), 'error')
      }
    }, true)
    this.setFooter([this.note(''), download])
  }

  private open(anchor: Anchor, targets: string[], target: string): void {
    this.close()
    this.anchor = anchor
    this.returnFocus = document.activeElement
    const host = document.createElement(UI_HOST_TAG)
    host.setAttribute('translate', 'no')
    const root = host.attachShadow({ mode: 'closed' })
    try {
      sheet ??= new CSSStyleSheet()
      sheet.replaceSync(STYLE)
      root.adoptedStyleSheets = [sheet]
    } catch {
      // A constructed sheet is supported by every Chromium this runs on.
    }
    const box = document.createElement('div')
    box.className = 'box'
    box.tabIndex = -1
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-label', t('selectionTitle'))
    const header = document.createElement('header')
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = t('appName')
    const select = document.createElement('select')
    select.setAttribute('aria-label', t('to'))
    for (const code of sortByName(targets, uiLanguage())) {
      const option = document.createElement('option')
      option.value = code
      option.textContent = languageName(code, uiLanguage())
      option.selected = code === target
      select.append(option)
    }
    select.addEventListener('change', (event) => {
      if (!event.isTrusted) return
      const text = this.lastText
      if (text) void this.translate(text, select.value, false)
    })
    const close = document.createElement('button')
    close.className = 'close'
    close.type = 'button'
    close.setAttribute('aria-label', t('close'))
    close.innerHTML = CLOSE_ICON
    close.addEventListener('click', (event) => { if (event.isTrusted) this.close() })
    header.append(title, select, close)
    const body = document.createElement('div')
    body.className = 'body muted'
    body.setAttribute('aria-live', 'polite')
    const footer = document.createElement('footer')
    box.append(header, body, footer)
    root.append(box)
    document.documentElement.append(host)
    Object.assign(this, { host, box, body, footer, select })
    this.place()
    requestAnimationFrame(() => box.classList.add('open'))
    box.focus({ preventScroll: true })
    document.addEventListener('keydown', this.onKey, true)
    document.addEventListener('pointerdown', this.onPointer, true)
    addEventListener('scroll', this.onScroll, { capture: true, passive: true })
    addEventListener('resize', this.onScroll, { passive: true })
  }

  private lastText = ''

  private message(text: string, kind: 'muted' | 'error' | 'result', progress = false): void {
    if (!this.body) return
    this.body.className = `body ${kind === 'result' ? '' : kind}`
    this.body.textContent = text
    if (progress) {
      const bar = document.createElement('div')
      bar.className = 'bar'
      bar.append(document.createElement('i'))
      this.body.append(bar)
    }
    this.place()
  }

  private setFooter(items: HTMLElement[]): void {
    this.footer?.replaceChildren(...items)
    this.place()
  }

  private note(text: string): HTMLElement {
    const span = document.createElement('span')
    span.className = 'grow'
    span.textContent = text
    return span
  }

  private button(label: string, action: () => void, primary = false): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (primary) button.className = 'primary'
    button.addEventListener('click', (event) => { if (event.isTrusted) action() })
    return button
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      this.box?.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    const button = this.footer?.querySelector('button')
    if (button) button.textContent = t('copied')
  }

  // Below the selection when it fits, above it otherwise, never over it; clamped to the viewport.
  private place(): void {
    if (!this.host || !this.box || !this.anchor) return
    const gap = 8
    let rect = this.anchor.fallback
    if (this.anchor.range) {
      const rects = this.anchor.range.getClientRects()
      const last = rects[rects.length - 1]
      const first = rects[0]
      const whole = this.anchor.range.getBoundingClientRect()
      if (first && last && (whole.width || whole.height)) rect = new DOMRect(whole.left, first.top, whole.width, last.bottom - first.top)
    }
    const width = this.box.offsetWidth || 360
    const height = this.box.offsetHeight || 140
    let top = rect.bottom + gap
    if (top + height > innerHeight - gap) top = rect.top - height - gap >= gap ? rect.top - height - gap : Math.max(gap, innerHeight - height - gap)
    const left = Math.min(innerWidth - width - gap, Math.max(gap, rect.left))
    this.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  close(): void {
    this.token += 1
    this.lastText = ''
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('pointerdown', this.onPointer, true)
    removeEventListener('scroll', this.onScroll, { capture: true })
    removeEventListener('resize', this.onScroll)
    this.host?.remove()
    this.host = this.box = this.body = this.footer = this.select = null
    this.anchor = null
    if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) this.returnFocus.focus({ preventScroll: true })
    this.returnFocus = null
  }
}
