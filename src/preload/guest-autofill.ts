import { ipcRenderer, webFrame } from 'electron/renderer'

const privacyDocumentScript = ipcRenderer.sendSync('vast:privacy:document-script', location.href)
if (typeof privacyDocumentScript === 'string' && privacyDocumentScript) {
  void webFrame.executeJavaScript(privacyDocumentScript).catch(() => undefined)
}

let captureController: AbortController | undefined
let loginFormObserver: MutationObserver | undefined
let loginFormScanTimer: number | undefined
let loginFormScanAttempts = 0
let lastCandidateSignature = ''
let lastCandidateAt = 0
let loginFormSignaled = false
const MAX_LOGIN_FORM_SCAN_ATTEMPTS = 6

function visibleInput(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && !input.disabled && !input.readOnly
}

function candidateFromScope(scope: ParentNode): { origin: string; username: string; password: string; title: string } | undefined {
  const passwordInputs = [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    .filter((input) => visibleInput(input) && input.value.length > 0)
  if (passwordInputs.length === 0) return undefined

  const newPasswordInputs = passwordInputs.filter((input) => input.autocomplete.toLowerCase() === 'new-password')
  const matchingNewPassword = newPasswordInputs.find((input, index) =>
    newPasswordInputs.some((other, otherIndex) => otherIndex !== index && other.value === input.value)
  )
  const currentPassword = passwordInputs.find((input) => input.autocomplete.toLowerCase() === 'current-password')
  const passwordInput = matchingNewPassword ?? newPasswordInputs[0] ?? currentPassword ?? passwordInputs[0]

  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input')].filter(visibleInput)
  const usernameInput = inputs.find((input) => input.autocomplete.toLowerCase() === 'username') ??
    inputs.find((input) => input.type.toLowerCase() === 'email') ??
    inputs.find((input) => {
      const type = (input.type || 'text').toLowerCase()
      if (!['text', 'tel'].includes(type) || input === passwordInput) return false
      const metadata = [input.name, input.id, input.autocomplete, input.getAttribute('aria-label') ?? '', input.placeholder]
        .join(' ')
        .toLowerCase()
      return /email|e-mail|username|user|login|account|phone/.test(metadata)
    }) ??
    inputs.find((input) => input !== passwordInput && ['text', 'email', 'tel'].includes((input.type || 'text').toLowerCase()))

  if (!location.origin || location.origin === 'null') return undefined
  return {
    origin: location.origin,
    username: usernameInput?.value.trim() ?? '',
    password: passwordInput.value,
    title: document.title.slice(0, 256)
  }
}

function captureFrom(target: EventTarget | null): void {
  const element = target instanceof Element ? target : null
  const scope = element?.closest('form') ?? document
  const candidate = candidateFromScope(scope)
  if (!candidate) return
  const signature = `${candidate.origin}\u0000${candidate.username}\u0000${candidate.password}`
  const now = Date.now()
  if (signature === lastCandidateSignature && now - lastCandidateAt < 3_000) return
  lastCandidateSignature = signature
  lastCandidateAt = now
  ipcRenderer.sendToHost('vast:password-login-candidate', candidate)
}

function hasLoginFormCandidate(): boolean {
  return [...document.querySelectorAll<HTMLInputElement>('input')].some((input) => {
    if (!visibleInput(input)) return false
    const type = (input.type || 'text').toLowerCase()
    if (type === 'password') return true
    if (!['email', 'text', 'tel'].includes(type)) return false
    const metadata = [input.name, input.id, input.autocomplete, input.getAttribute('aria-label') ?? '', input.placeholder]
      .join(' ')
      .toLowerCase()
    return input.autocomplete.toLowerCase() === 'username' || /email|e-mail|username|user|login|account|phone/.test(metadata)
  })
}

function queueLoginFormScan(): void {
  if (loginFormSignaled || loginFormScanTimer !== undefined) return
  loginFormScanTimer = window.setTimeout(() => {
    loginFormScanTimer = undefined
    if (loginFormSignaled) return
    if (!hasLoginFormCandidate()) {
      loginFormScanAttempts += 1
      if (loginFormScanAttempts < MAX_LOGIN_FORM_SCAN_ATTEMPTS) queueLoginFormScan()
      return
    }
    loginFormSignaled = true
    ipcRenderer.sendToHost('vast:login-form-available')
  }, 80)
}

function scheduleLoginFormSignal(): void {
  loginFormScanAttempts = 0
  queueLoginFormScan()
}

function configureCapture(enabled: boolean): void {
  captureController?.abort()
  captureController = undefined
  loginFormObserver?.disconnect()
  loginFormObserver = undefined
  if (loginFormScanTimer !== undefined) window.clearTimeout(loginFormScanTimer)
  loginFormScanTimer = undefined
  loginFormScanAttempts = 0
  lastCandidateSignature = ''
  lastCandidateAt = 0
  loginFormSignaled = false
  if (!enabled) return

  const controller = new AbortController()
  captureController = controller
  document.addEventListener('submit', (event) => captureFrom(event.target), { capture: true, signal: controller.signal })
  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element ? event.target.closest('button, input') : null
    if (!element) return
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : (element.getAttribute('type') ?? 'submit').toLowerCase()
    if (type === 'submit' || /sign in|log in|login|continue|register|create account|save password/i.test(element.textContent ?? '')) {
      captureFrom(element)
    }
  }, { capture: true, signal: controller.signal })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') captureFrom(event.target)
  }, { capture: true, signal: controller.signal })

  loginFormObserver = new MutationObserver(scheduleLoginFormSignal)
  loginFormObserver.observe(document.documentElement, { childList: true, subtree: true })
  scheduleLoginFormSignal()
}

ipcRenderer.on('vast:password-capture-config', (_event, input: unknown) => {
  const enabled = Boolean(input && typeof input === 'object' && (input as { enabled?: unknown }).enabled === true)
  configureCapture(enabled)
})

interface AutofillSuggestion {
  id: string
  username: string
  title: string
}

let autofillController: AbortController | undefined
let autofillObserver: MutationObserver | undefined
let autofillScanTimer: number | undefined
let autofillRoot: HTMLDivElement | undefined
let autofillStyle: HTMLStyleElement | undefined
let autofillBoundInputs = new WeakSet<HTMLInputElement>()
const pendingAutofillRoots = new Set<Node>()

function validatedAutofillSuggestions(input: unknown): AutofillSuggestion[] {
  if (!input || typeof input !== 'object' || (input as { enabled?: unknown }).enabled !== true) return []
  const suggestions = (input as { suggestions?: unknown }).suggestions
  if (!Array.isArray(suggestions)) return []
  const validated: AutofillSuggestion[] = []
  for (const suggestion of suggestions.slice(0, 100)) {
    if (!suggestion || typeof suggestion !== 'object') continue
    const candidate = suggestion as { id?: unknown; username?: unknown; title?: unknown }
    if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(candidate.id)) continue
    if (typeof candidate.username !== 'string' || candidate.username.length > 512) continue
    if (typeof candidate.title !== 'string' || candidate.title.length > 512) continue
    validated.push({ id: candidate.id, username: candidate.username, title: candidate.title })
  }
  return validated
}

function cleanupAutofill(): void {
  autofillObserver?.disconnect()
  autofillObserver = undefined
  autofillController?.abort()
  autofillController = undefined
  if (autofillScanTimer !== undefined) window.clearTimeout(autofillScanTimer)
  autofillScanTimer = undefined
  pendingAutofillRoots.clear()
  autofillBoundInputs = new WeakSet<HTMLInputElement>()
  autofillRoot?.remove()
  autofillRoot = undefined
  autofillStyle?.remove()
  autofillStyle = undefined
}

function isAutofillLoginInput(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false
  const type = (input.getAttribute('type') || 'text').toLowerCase()
  if (type === 'password' || type === 'email') return true
  if (type !== 'text' && type !== 'tel') return false
  const metadata = [
    input.getAttribute('autocomplete') || '',
    input.getAttribute('name') || '',
    input.getAttribute('id') || '',
    input.getAttribute('aria-label') || '',
    input.getAttribute('placeholder') || ''
  ].join(' ').toLowerCase()
  return /email|e-mail|username|login|user|account|phone/.test(metadata)
}

function configureAutofill(input: unknown): void {
  cleanupAutofill()
  const suggestions = validatedAutofillSuggestions(input)
  if (suggestions.length === 0 || !document.head || !document.body) return

  const controller = new AbortController()
  autofillController = controller
  const style = document.createElement('style')
  autofillStyle = style
  style.id = '__vast_af_style'
  style.textContent = [
    '#__vast_af_root{position:fixed;z-index:2147483647;background:#0c0d12;border:1px solid rgba(255,255,255,0.10);border-radius:14px;padding:5px;box-shadow:0 12px 40px rgba(0,0,0,.55);display:none;min-width:220px;max-width:300px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:13px;color:#f3f5f8}',
    '#__vast_af_root.visible{display:block}',
    '#__vast_af_header{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7a99;padding:4px 10px 6px}',
    '.vast-af-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:9px;cursor:pointer;border:none;background:transparent;width:100%;text-align:left;color:#f3f5f8}',
    '.vast-af-item:hover,.vast-af-item.focused{background:rgba(116,231,255,.08)}',
    '.vast-af-icon{width:26px;height:26px;border-radius:8px;background:rgba(116,231,255,.10);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.vast-af-label{min-width:0;flex:1}',
    '.vast-af-username{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f3f5f8}',
    '.vast-af-site{font-size:10.5px;color:#6b7a99;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.vast-af-fill{font-size:13px;font-weight:600;color:#74e7ff;flex-shrink:0}'
  ].join('')
  document.head.appendChild(style)

  const root = document.createElement('div')
  autofillRoot = root
  root.id = '__vast_af_root'
  const header = document.createElement('div')
  header.id = '__vast_af_header'
  header.textContent = 'Saved logins'
  root.appendChild(header)

  let focusedIndex = -1
  const items: HTMLButtonElement[] = []
  const updateFocus = (): void => items.forEach((button, index) => button.classList.toggle('focused', index === focusedIndex))
  const hide = (): void => {
    root.classList.remove('visible')
    focusedIndex = -1
  }
  const select = (credentialId: string): void => {
    ipcRenderer.sendToHost('vast:autofill-select', credentialId)
    hide()
  }

  suggestions.forEach((suggestion, index) => {
    const button = document.createElement('button')
    button.className = 'vast-af-item'
    button.type = 'button'
    const icon = document.createElement('div')
    icon.className = 'vast-af-icon'
    icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#74e7ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
    const label = document.createElement('div')
    label.className = 'vast-af-label'
    const username = document.createElement('div')
    username.className = 'vast-af-username'
    username.textContent = suggestion.username || '(no username)'
    const site = document.createElement('div')
    site.className = 'vast-af-site'
    site.textContent = suggestion.title
    const fill = document.createElement('div')
    fill.className = 'vast-af-fill'
    fill.textContent = 'Fill'
    label.append(username, site)
    button.append(icon, label, fill)
    button.addEventListener('mouseenter', () => {
      focusedIndex = index
      updateFocus()
    }, { signal: controller.signal })
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      select(suggestion.id)
    }, { signal: controller.signal })
    root.appendChild(button)
    items.push(button)
  })
  document.body.appendChild(root)

  const show = (input: HTMLInputElement): void => {
    const rect = input.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const dropdownHeight = 44 * suggestions.length + 36
    root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`
    if (viewportHeight - rect.bottom >= dropdownHeight || viewportHeight - rect.bottom >= rect.top) {
      root.style.top = `${rect.bottom + 4}px`
      root.style.bottom = ''
    } else {
      root.style.bottom = `${viewportHeight - rect.top + 4}px`
      root.style.top = ''
    }
    focusedIndex = -1
    updateFocus()
    root.classList.add('visible')
  }

  document.addEventListener('keydown', (event) => {
    if (!root.classList.contains('visible')) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusedIndex = Math.min(focusedIndex + 1, items.length - 1)
      updateFocus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusedIndex = Math.max(focusedIndex - 1, 0)
      updateFocus()
    } else if (event.key === 'Enter' && focusedIndex >= 0) {
      event.preventDefault()
      select(suggestions[focusedIndex].id)
    } else if (event.key === 'Escape') {
      hide()
    }
  }, { capture: true, signal: controller.signal })

  document.addEventListener('mousedown', (event) => {
    if (!root.contains(event.target as Node)) hide()
  }, { capture: true, signal: controller.signal })

  const bindTo = (input: HTMLInputElement): void => {
    if (autofillBoundInputs.has(input)) return
    autofillBoundInputs.add(input)
    input.addEventListener('focus', () => show(input), { signal: controller.signal })
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!root.contains(document.activeElement)) hide()
      }, 150)
    }, { signal: controller.signal })
  }

  const inputsWithin = (node: Node): HTMLInputElement[] => {
    const inputs: HTMLInputElement[] = []
    if (node instanceof HTMLInputElement) inputs.push(node)
    if (node instanceof Element || node instanceof Document || node instanceof DocumentFragment) {
      inputs.push(...node.querySelectorAll<HTMLInputElement>('input'))
    }
    return inputs
  }

  const scanSubtree = (node: Node): void => {
    const inputs = inputsWithin(node)
    for (const input of inputs) {
      if (isAutofillLoginInput(input)) bindTo(input)
      if ((input.getAttribute('type') || 'text').toLowerCase() !== 'password') continue
      const scope = input.closest('form') ?? document
      for (const related of scope.querySelectorAll<HTMLInputElement>('input')) {
        if (isAutofillLoginInput(related)) bindTo(related)
      }
    }
  }

  const flushChangedSubtrees = (): void => {
    autofillScanTimer = undefined
    const roots = [...pendingAutofillRoots]
    pendingAutofillRoots.clear()
    for (const changedRoot of roots) scanSubtree(changedRoot)
  }
  const queueChangedSubtrees = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) pendingAutofillRoots.add(node)
    if (pendingAutofillRoots.size === 0 || autofillScanTimer !== undefined) return
    autofillScanTimer = window.setTimeout(flushChangedSubtrees, 80)
  }

  scanSubtree(document)
  const active = document.activeElement
  if (active instanceof HTMLInputElement && isAutofillLoginInput(active)) show(active)
  autofillObserver = new MutationObserver(queueChangedSubtrees)
  autofillObserver.observe(document.documentElement, { childList: true, subtree: true })
}

ipcRenderer.on('vast:password-autofill-config', (_event, input: unknown) => configureAutofill(input))

let scrollBoundaryFrame = 0
let pendingScrollTarget: EventTarget | null = null
let lastScrollAtTop: boolean | undefined
let topOverscrollDistance = 0
let topOverscrollVisible = false

function scrollTopFor(target: EventTarget | null): number {
  if (target instanceof Element && target.scrollHeight > target.clientHeight + 2) return target.scrollTop
  const scrollingElement = document.scrollingElement
  return Math.max(window.scrollY, scrollingElement?.scrollTop ?? 0)
}

function publishScrollBoundary(target: EventTarget | null = null): void {
  const atTop = scrollTopFor(target) <= 1
  if (atTop === lastScrollAtTop) return
  lastScrollAtTop = atTop
  ipcRenderer.sendToHost('vast:scroll-boundary', atTop)
  if (!atTop && topOverscrollVisible) {
    topOverscrollVisible = false
    topOverscrollDistance = 0
    ipcRenderer.sendToHost('vast:purist-top-overscroll', 'hide')
  }
}

function documentIsAtTop(): boolean {
  const scrollingElement = document.scrollingElement
  return Math.max(window.scrollY, scrollingElement?.scrollTop ?? 0) <= 1
}

function onTopOverscrollWheel(event: WheelEvent): void {
  if (event.deltaY < 0 && documentIsAtTop() && scrollTopFor(event.target) <= 1) {
    topOverscrollDistance = Math.min(48, topOverscrollDistance + Math.abs(event.deltaY))
    if (!topOverscrollVisible && topOverscrollDistance >= 18) {
      topOverscrollVisible = true
      ipcRenderer.sendToHost('vast:purist-top-overscroll', 'show')
    }
    return
  }
  if (event.deltaY <= 0) return
  topOverscrollDistance = 0
  if (!topOverscrollVisible) return
  topOverscrollVisible = false
  ipcRenderer.sendToHost('vast:purist-top-overscroll', 'hide')
}

function queueScrollBoundary(event?: Event): void {
  pendingScrollTarget = event?.target ?? pendingScrollTarget
  if (scrollBoundaryFrame) return
  scrollBoundaryFrame = window.requestAnimationFrame(() => {
    scrollBoundaryFrame = 0
    const target = pendingScrollTarget
    pendingScrollTarget = null
    publishScrollBoundary(target)
  })
}

document.addEventListener('scroll', queueScrollBoundary, { capture: true, passive: true })
document.addEventListener('wheel', onTopOverscrollWheel, { capture: true, passive: true })
window.addEventListener('pageshow', () => queueScrollBoundary())
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => queueScrollBoundary(), { once: true })
} else {
  queueScrollBoundary()
}
