// Optional: registered only when the user turns on the selection button. Watches pointer-up and
// key-up for a non-empty selection and offers one small button; nothing is translated until a
// trusted click on it.

const HOST = 'tfv-button'
const STYLE = ':host{all:initial;position:fixed;z-index:2147483647;top:0;left:0}button{all:unset;box-sizing:border-box;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#0d0d0f;color:#f5f7fb;border:1px solid rgba(255,255,255,.18);box-shadow:0 6px 18px rgba(0,0,0,.28);cursor:pointer}button:hover{background:#1a1a1d}button:focus-visible{outline:2px solid #f5f7fb;outline-offset:2px}svg{width:15px;height:15px}'
const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h6M5 2v1.5M3.2 3.5c.5 2 1.9 3.6 3.8 4.4M6.8 3.5c-.5 2.2-2 4-4.3 4.9"/><path d="M8.5 14l2.7-6.5L14 14M9.5 12h3.4"/></svg>'

if (!(globalThis as { __tfvButton?: boolean }).__tfvButton) {
  ;(globalThis as { __tfvButton?: boolean }).__tfvButton = true
  let host: HTMLElement | null = null
  const remove = () => {
    host?.remove()
    host = null
  }
  const offer = () => {
    remove()
    const selection = getSelection()
    const text = selection?.toString().trim() ?? ''
    if (!selection || selection.rangeCount === 0 || text.length < 2) return
    const anchor = selection.anchorNode
    const editable = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
    if (editable) return
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    if (!rect.width && !rect.height) return
    host = document.createElement(HOST)
    const root = host.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(STYLE)
    root.adoptedStyleSheets = [sheet]
    const button = document.createElement('button')
    button.type = 'button'
    button.title = button.ariaLabel = chrome.i18n.getUILanguage().startsWith('pl') ? 'Przetłumacz zaznaczenie' : 'Translate selection'
    button.innerHTML = ICON
    // Pressing must not clear the selection before it is read.
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      remove()
      void chrome.runtime.sendMessage({ scope: 'tfv', type: 'content:selection-request', text: text.slice(0, 20_000) }).catch(() => undefined)
    })
    root.append(button)
    const top = rect.bottom + 6 + 28 <= innerHeight ? rect.bottom + 6 : Math.max(6, rect.top - 34)
    const left = Math.min(innerWidth - 34, Math.max(6, rect.right - 14))
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    document.documentElement.append(host)
  }
  document.addEventListener('pointerup', (event) => {
    if (host && event.composedPath().includes(host)) return
    setTimeout(offer, 0)
  }, true)
  document.addEventListener('keyup', (event) => { if (event.shiftKey || event.key === 'Shift') setTimeout(offer, 0) }, true)
  document.addEventListener('pointerdown', (event) => { if (host && !event.composedPath().includes(host)) remove() }, true)
  addEventListener('scroll', remove, { capture: true, passive: true })
}
