import { contextBridge, ipcRenderer, webFrame } from 'electron/renderer'
import interRegularDataUrl from '../../assets/fonts/InterDisplay-Regular.woff2?url&inline'
import interSemiBoldDataUrl from '../../assets/fonts/InterDisplay-SemiBold.woff2?url&inline'
import { installDocumentSpoofing, type DocumentSpoofingConfig } from '../shared/spoofing'
import { configureCredentialCapture } from './credential-capture-runtime'
import {
  autofillPasswordInput,
  autofillUsernameInput,
  credentialScopeFor,
  isAutofillCredentialInput,
  visibleCredentialInput
} from './credential-form-parser'

const spoofingDocumentConfig = ipcRenderer.sendSync('vast:spoofing:document-config', location.href) as DocumentSpoofingConfig | null
if (spoofingDocumentConfig) {
  try {
    contextBridge.executeInMainWorld({ func: installDocumentSpoofing, args: [spoofingDocumentConfig] })
  } catch {
    // Network headers remain coherent if Chromium locks down one JS surface.
  }
}

const privacyDocumentScript = ipcRenderer.sendSync('vast:privacy:document-script', location.href)
if (typeof privacyDocumentScript === 'string' && privacyDocumentScript) {
  void webFrame.executeJavaScript(privacyDocumentScript).catch(() => undefined)
}

ipcRenderer.on('vast:password-capture-config', (_event, input: unknown) => {
  const enabled = Boolean(input && typeof input === 'object' && (input as { enabled?: unknown }).enabled === true)
  configureCredentialCapture(enabled)
})

interface AutofillSuggestion {
  id: string
  username: string
  title: string
}

interface AutofillTheme {
  mode: 'dark' | 'dim' | 'light'
  accent: string
}

let autofillController: AbortController | undefined
let autofillObserver: MutationObserver | undefined
let autofillScanTimer: number | undefined
let autofillRoot: HTMLDivElement | undefined
let autofillStyle: HTMLStyleElement | undefined
let autofillBoundInputs = new WeakSet<HTMLInputElement>()
let autofillActiveInput: HTMLInputElement | undefined
let autofillInterLoad: Promise<void> | undefined
let autofillInterSettled = false
let pendingAutofillRequest: {
  requestId: string
  credentialId: string
  target: HTMLInputElement
  expiresAt: number
} | undefined
let usernameAutofilledInputs = new WeakSet<HTMLInputElement>()
const pendingAutofillRoots = new Set<Node>()

function embeddedFontBuffer(dataUrl: string): ArrayBuffer {
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error('Invalid bundled font data.')
  const binary = atob(dataUrl.slice(separator + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function ensureAutofillInter(): Promise<void> {
  if (autofillInterLoad) return autofillInterLoad
  const faces = [
    new FontFace('Vast Autofill Inter', embeddedFontBuffer(interRegularDataUrl), {
      style: 'normal',
      weight: '400'
    }),
    new FontFace('Vast Autofill Inter', embeddedFontBuffer(interSemiBoldDataUrl), {
      style: 'normal',
      weight: '600'
    })
  ]
  autofillInterLoad = Promise.all(faces.map((face) => face.load())).then((fonts) => {
    for (const font of fonts) document.fonts.add(font)
  }).catch(() => {
    // The menu still remains usable if a future Chromium build rejects the
    // embedded face, but current builds load it without relying on page CSP.
  }).finally(() => {
    autofillInterSettled = true
  })
  return autofillInterLoad
}

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

function validatedAutofillTheme(input: unknown): AutofillTheme {
  const candidate = input && typeof input === 'object'
    ? (input as { theme?: unknown; accent?: unknown })
    : undefined
  const mode = candidate?.theme === 'light' || candidate?.theme === 'dim' ? candidate.theme : 'dark'
  const accent = typeof candidate?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(candidate.accent)
    ? candidate.accent
    : '#c084fc'
  return { mode, accent }
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
  usernameAutofilledInputs = new WeakSet<HTMLInputElement>()
  autofillActiveInput = undefined
  pendingAutofillRequest = undefined
  autofillRoot?.remove()
  autofillRoot = undefined
  autofillStyle?.remove()
  autofillStyle = undefined
}

function isAutofillLoginInput(input: HTMLInputElement): boolean {
  return isAutofillCredentialInput(input)
}

function setAutofillInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function randomAutofillRequestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function fillCredentialFromMain(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const payload = input as {
    id?: unknown
    origin?: unknown
    username?: unknown
    password?: unknown
    requestId?: unknown
    trustedSurfaceAction?: unknown
  }
  if (
    typeof payload.id !== 'string' || payload.id.length > 256 ||
    typeof payload.origin !== 'string' || payload.origin !== location.origin ||
    typeof payload.username !== 'string' || payload.username.length > 512 ||
    typeof payload.password !== 'string' || payload.password.length < 1 || payload.password.length > 4096
  ) return

  const trustedSurfaceAction = payload.trustedSurfaceAction === true
  const pending = pendingAutofillRequest
  const pendingMatches = Boolean(
    pending &&
    pending.expiresAt >= Date.now() &&
    pending.credentialId === payload.id &&
    typeof payload.requestId === 'string' &&
    pending.requestId === payload.requestId &&
    pending.target.isConnected
  )
  if (!trustedSurfaceAction && !pendingMatches) return
  pendingAutofillRequest = undefined

  const active = pendingMatches
    ? pending?.target
    : document.activeElement instanceof HTMLInputElement && isAutofillLoginInput(document.activeElement)
      ? document.activeElement
      : undefined
  const fallbackPasswords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    .filter((candidate) => visibleCredentialInput(candidate) && candidate.autocomplete.toLowerCase() !== 'new-password')
  const passwordInput = active?.type.toLowerCase() === 'password'
    ? active.autocomplete.toLowerCase() === 'new-password' ? undefined : active
    : active
      ? autofillPasswordInput(credentialScopeFor(active))
      : fallbackPasswords.length === 1 ? fallbackPasswords[0] : undefined
  const scope = credentialScopeFor(passwordInput ?? active ?? null)
  const usernameInput = active && active.type.toLowerCase() !== 'password'
    ? active
    : autofillUsernameInput(scope, passwordInput)

  if (usernameInput && payload.username) setAutofillInputValue(usernameInput, payload.username)
  if (passwordInput) setAutofillInputValue(passwordInput, payload.password)
  payload.username = ''
  payload.password = ''
}

ipcRenderer.on('vast:password-autofill-fill', (_event, input: unknown) => fillCredentialFromMain(input))

function configureAutofill(input: unknown): void {
  cleanupAutofill()
  const suggestions = validatedAutofillSuggestions(input)
  if (suggestions.length === 0 || !document.head || !document.body) return
  const theme = validatedAutofillTheme(input)
  void ensureAutofillInter()

  const controller = new AbortController()
  autofillController = controller
  const root = document.createElement('div')
  autofillRoot = root
  root.id = '__vast_af_root'
  root.dataset.theme = theme.mode
  root.style.setProperty('--vast-af-accent', theme.accent)
  const shadow = root.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  autofillStyle = style
  style.id = '__vast_af_style'
  style.textContent = [
    ':host{all:initial;--vast-af-bg:#090a0d;--vast-af-text:#f4f3f6;--vast-af-muted:rgba(244,243,246,.63);--vast-af-divider:rgba(255,255,255,.065);--vast-af-hover:color-mix(in srgb,var(--vast-af-accent) 4%,transparent);box-sizing:border-box;position:fixed;z-index:2147483647;width:min(348px,calc(100vw - 20px));max-height:min(360px,calc(100vh - 20px));overflow-x:hidden;overflow-y:auto;background:var(--vast-af-bg);border:0;border-radius:15px;padding:10px;box-shadow:0 14px 38px rgba(0,0,0,.42);display:none;font-family:"Vast Autofill Inter"!important;font-size:14px;font-weight:400;font-synthesis:none;color:var(--vast-af-text);color-scheme:dark}',
    ':host([data-theme="dim"]){--vast-af-bg:#202022;--vast-af-text:#f1f0f2;--vast-af-muted:rgba(241,240,242,.6);--vast-af-divider:rgba(255,255,255,.075);box-shadow:0 12px 34px rgba(0,0,0,.3)}',
    ':host([data-theme="light"]){--vast-af-bg:#f7f7f8;--vast-af-text:#17171a;--vast-af-muted:rgba(23,23,26,.6);--vast-af-divider:rgba(23,23,26,.08);--vast-af-hover:color-mix(in srgb,var(--vast-af-accent) 4%,transparent);box-shadow:0 14px 36px rgba(24,20,35,.14);color-scheme:light}',
    ':host(.visible){display:block}',
    ':host::-webkit-scrollbar{width:7px}',
    ':host::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--vast-af-text) 14%,transparent);border:2px solid var(--vast-af-bg);border-radius:999px}',
    '#__vast_af_header{font-family:"Vast Autofill Inter"!important;font-size:13px;font-weight:600;line-height:1.3;letter-spacing:-.005em;color:var(--vast-af-text);padding:4px 9px 8px}',
    '.vast-af-item{position:relative;display:flex;align-items:center;gap:11px;min-height:46px;padding:7px 9px;border-radius:9px;cursor:pointer;border:0;outline:0;background:transparent;width:100%;box-sizing:border-box;text-align:left;font-family:"Vast Autofill Inter"!important;font-size:13.5px;font-weight:400;color:var(--vast-af-text);transition:background-color 100ms ease}',
    '.vast-af-item+.vast-af-item::before{content:"";position:absolute;top:0;left:9px;right:9px;height:1px;background:var(--vast-af-divider)}',
    '.vast-af-item:hover,.vast-af-item.focused{background:var(--vast-af-hover)}',
    '.vast-af-item.focused .vast-af-username{color:var(--vast-af-text)}',
    '.vast-af-icon{width:23px;height:23px;color:var(--vast-af-accent);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.vast-af-icon svg{width:18px;height:18px;stroke-width:1.8}',
    '.vast-af-label{min-width:0;flex:1}',
    '.vast-af-username{font-family:"Vast Autofill Inter"!important;font-size:13.5px;font-weight:400;line-height:1.35;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vast-af-muted)}'
  ].join('')
  shadow.appendChild(style)
  const header = document.createElement('div')
  header.id = '__vast_af_header'
  header.textContent = 'Saved logins'
  shadow.appendChild(header)

  let focusedIndex = -1
  const items: HTMLButtonElement[] = []
  const updateFocus = (): void => items.forEach((button, index) => button.classList.toggle('focused', index === focusedIndex))
  const hide = (): void => {
    root.classList.remove('visible')
    focusedIndex = -1
  }
  const maybeAutofillUsername = (input: HTMLInputElement): void => {
    const type = (input.getAttribute('type') || 'text').toLowerCase()
    const preferredUsername = suggestions[0]?.username
    if (type === 'password' || !preferredUsername || input.value || !visibleCredentialInput(input) || usernameAutofilledInputs.has(input)) return
    usernameAutofilledInputs.add(input)
    setAutofillInputValue(input, preferredUsername)
  }
  const select = (credentialId: string, event: MouseEvent | KeyboardEvent): void => {
    if (!event.isTrusted || !autofillActiveInput?.isConnected) return
    const requestId = randomAutofillRequestId()
    pendingAutofillRequest = {
      requestId,
      credentialId,
      target: autofillActiveInput,
      expiresAt: Date.now() + 2 * 60_000
    }
    ipcRenderer.sendToHost('vast:autofill-select', credentialId, requestId)
    hide()
  }

  suggestions.forEach((suggestion, index) => {
    const button = document.createElement('button')
    button.className = 'vast-af-item'
    button.type = 'button'
    const icon = document.createElement('div')
    icon.className = 'vast-af-icon'
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
    const label = document.createElement('div')
    label.className = 'vast-af-label'
    const username = document.createElement('div')
    username.className = 'vast-af-username'
    username.textContent = suggestion.username || '(no username)'
    label.append(username)
    button.append(icon, label)
    button.addEventListener('mouseenter', () => {
      focusedIndex = index
      updateFocus()
    }, { signal: controller.signal })
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      select(suggestion.id, event)
    }, { signal: controller.signal })
    shadow.appendChild(button)
    items.push(button)
  })
  document.body.appendChild(root)

  const show = (input: HTMLInputElement): void => {
    if (!visibleCredentialInput(input)) return
    if (!autofillInterSettled) {
      void ensureAutofillInter().then(() => {
        if (input.isConnected && document.activeElement === input) show(input)
      })
      return
    }
    maybeAutofillUsername(input)
    autofillActiveInput = input
    const rect = input.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const dropdownWidth = Math.min(348, window.innerWidth - 20)
    const dropdownHeight = Math.min(360, 46 * suggestions.length + 46)
    root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - dropdownWidth - 8))}px`
    if (viewportHeight - rect.bottom >= dropdownHeight || viewportHeight - rect.bottom >= rect.top) {
      root.style.top = `${rect.bottom + 8}px`
      root.style.bottom = ''
    } else {
      root.style.bottom = `${viewportHeight - rect.top + 8}px`
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
      select(suggestions[focusedIndex].id, event)
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
      const scope = credentialScopeFor(input)
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

function onZoomWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
  ipcRenderer.sendToHost('vast:wheel-zoom', event.deltaY * scale)
}

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
document.addEventListener('wheel', onZoomWheel, { capture: true, passive: false })
document.addEventListener('wheel', onTopOverscrollWheel, { capture: true, passive: true })
window.addEventListener('pageshow', () => queueScrollBoundary())
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => queueScrollBoundary(), { once: true })
} else {
  queueScrollBoundary()
}
