/** Runs only in the isolated preload world, following a main-issued picker token. */
export function installElementPicker(save: (selector?: string) => Promise<{ ok: boolean; error?: string }>): () => void {
  const controller = new AbortController()
  const root = document.createElement('div')
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const shadow = root.attachShadow({ mode: 'closed' })
  const highlight = document.createElement('div')
  highlight.style.cssText = 'position:fixed;border:2px solid #72e6df;background:#72e6df22;pointer-events:none;border-radius:4px'
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);width:380px;max-width:85vw;padding:18px;background:#101116;color:#eee;border:1px solid #ffffff26;border-radius:16px;font:13px/1.5 system-ui;pointer-events:auto;box-shadow:0 12px 48px #0008'
  const title = document.createElement('strong'); title.textContent = 'Adblocker for Vast'
  const detail = document.createElement('p'); detail.textContent = 'Select an element to preview. Esc cancels.'
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:12px;margin-top:12px'
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'
  const confirm = document.createElement('button'); confirm.textContent = 'Block element'; confirm.disabled = true
  for (const button of [cancel, confirm]) button.style.cssText = 'border:1px solid #ffffff26;background:#ffffff0d;color:inherit;border-radius:8px;padding:7px 12px;cursor:pointer'
  actions.append(cancel, confirm); panel.append(title, detail, actions); shadow.append(highlight, panel); document.documentElement.append(root)
  let selected: Element | undefined, selector: string | undefined, preview: HTMLStyleElement | undefined, finished = false
  const close = (): void => { if (finished) return; finished = true; controller.abort(); preview?.remove(); root.remove() }
  const abort = (): void => { close(); void save().catch(() => undefined) }
  const options = { capture: true, signal: controller.signal }
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); abort() } }, options)
  document.addEventListener('mousemove', (event) => {
    if (selector || !event.isTrusted || event.composedPath().includes(root)) return
    const element = event.target
    if (!(element instanceof Element) || ['HTML', 'BODY', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return
    selected = element
    const box = element.getBoundingClientRect()
    Object.assign(highlight.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
  }, options)
  document.addEventListener('click', (event) => {
    if (!event.isTrusted || event.composedPath().includes(root)) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (selector || !selected || event.target !== selected) return
    const parts: string[] = []
    let element: Element | null = selected
    for (let depth = 0; element && element !== document.body && depth < 8; depth++, element = element.parentElement) {
      const siblings: Element[] = element.parentElement ? Array.from(element.parentElement.children).filter((child) => child.tagName === element!.tagName) : [element]
      parts.unshift(`${CSS.escape(element.tagName.toLowerCase())}${element.id ? `#${CSS.escape(element.id)}` : ''}:nth-of-type(${siblings.indexOf(element) + 1})`)
      const candidate = parts.join(' > ')
      if (candidate.length <= 512 && document.querySelectorAll(candidate).length === 1) { selector = candidate; break }
    }
    if (!selector) { detail.textContent = 'Could not create a narrow rule. Choose another element.'; return }
    detail.textContent = selector
    detail.style.cssText = 'overflow-wrap:anywhere;max-height:100px;overflow:auto'
    preview = document.createElement('style'); preview.textContent = `${selector}{visibility:hidden!important}`
    document.documentElement.append(preview)
    confirm.disabled = false
  }, options)
  cancel.addEventListener('click', (event) => { if (event.isTrusted) abort() }, { signal: controller.signal })
  confirm.addEventListener('click', (event) => {
    if (!event.isTrusted || !selector) return
    confirm.disabled = true
    void save(selector).then((result) => {
      if (result.ok) close()
      else { preview?.remove(); detail.textContent = result.error ?? 'Could not save the rule. Cancel and try again.' }
    }).catch(() => { detail.textContent = 'Could not save the rule. Cancel and try again.' })
  }, { signal: controller.signal })
  setTimeout(() => { if (!finished) abort() }, 120_000)
  return abort
}
