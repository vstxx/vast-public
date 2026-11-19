import { catalogLanguages, pairDiskBytes, pairDownloadBytes, parseCatalog, type Catalog } from '../shared/catalog.ts'
import { languageName, normalizeLanguageTag, sortByName } from '../shared/languages.ts'
import { formatBytes, t, uiLanguage } from '../shared/i18n.ts'
import { errorMessage, type DownloadProgress, type EnginePhase, type InstalledPair } from '../shared/protocol.ts'
import { loadSettings, normalizeHost, saveSettings, type Settings } from '../shared/settings.ts'
import { h, localize, onEngineEvents, PHASE_KEYS, request } from './common.ts'

const language = uiLanguage()
const name = (code: string) => languageName(code, language)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let settings: Settings
let catalog: Catalog
let installed: InstalledPair[] = []
const progress = new Map<string, DownloadProgress>()

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch)
  await request('ui:settings-changed').catch(() => undefined)
  renderSettings()
}

function languageSelect(codes: string[], selected: string | null, placeholder?: string): HTMLSelectElement {
  const select = h('select')
  if (placeholder) select.append(h('option', { value: '' }, placeholder))
  for (const code of sortByName(codes, language)) select.append(h('option', { value: code, selected: code === selected }, name(code)))
  return select
}

function languageList(key: 'alwaysTranslate' | 'neverTranslateLanguages', mount: HTMLElement, codes: string[]): void {
  const chips = h('div', { className: 'chips' }, ...settings[key].map((code) => h('span', { className: 'chip' }, name(code), h('button', { type: 'button', 'aria-label': `${t('optionsRemove')} ${name(code)}`, onclick: () => void save({ [key]: settings[key].filter((entry) => entry !== code) }) }, '×'))))
  const add = languageSelect(codes.filter((code) => !settings[key].includes(code)), null, t('optionsAddLanguage'))
  add.addEventListener('change', () => { if (add.value) void save({ [key]: [...settings[key], add.value] }) })
  mount.replaceChildren(chips, add)
}

function renderSettings(): void {
  const { sources, targets } = catalogLanguages(catalog)
  const browser = normalizeLanguageTag(chrome.i18n.getUILanguage()) ?? 'en'
  const target = languageSelect(targets, settings.targetLanguage, t('optionsTargetAuto', { language: name(targets.includes(browser) ? browser : 'en') }))
  target.addEventListener('change', () => void save({ targetLanguage: target.value || null }))
  $('target').replaceChildren(target)

  const display = $('display')
  for (const button of display.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === settings.displayMode))
  $<HTMLInputElement>('selection-button').checked = settings.selectionButton
  languageList('alwaysTranslate', $('always'), sources.filter((code) => code !== 'en' || targets.length > 1))
  languageList('neverTranslateLanguages', $('never-languages'), sources)

  $('never-sites').replaceChildren(h('div', { className: 'chips' }, ...settings.neverTranslateSites.map((site) => h('span', { className: 'chip' }, site, h('button', { type: 'button', 'aria-label': `${t('optionsRemove')} ${site}`, onclick: () => void save({ neverTranslateSites: settings.neverTranslateSites.filter((entry) => entry !== site) }) }, '×')))))
  const idle = $<HTMLSelectElement>('idle')
  idle.replaceChildren(...[15, 30, 60, 120, 300].map((seconds) => h('option', { value: String(seconds), selected: seconds === settings.idleSeconds }, t('optionsSeconds', { count: seconds }))))
}

function renderModels(): void {
  const list = $('installed')
  list.replaceChildren(...installed.map((pair) => h('li', {},
    h('div', { className: 'grow' }, h('div', {}, `${name(pair.source)} → ${name(pair.target)}`), h('div', { className: 'meta' }, `${formatBytes(pair.bytes)} · ${t('offlineReady')}`)),
    h('button', { type: 'button', className: 'danger', onclick: async () => {
      await request('ui:delete-model', { pairKey: pair.pairKey }).catch((error: unknown) => alert(errorMessage(error)))
      await refreshModels()
    } }, t('optionsDelete')))))
  $('no-models').hidden = installed.length > 0
  $<HTMLButtonElement>('delete-all').disabled = installed.length === 0

  const filter = $<HTMLInputElement>('filter').value.trim().toLocaleLowerCase(language)
  const have = new Set(installed.map((pair) => pair.pairKey))
  const pairs = Object.entries(catalog.pairs)
    .filter(([key, pair]) => !have.has(key) && (!filter || `${name(pair.source)} ${name(pair.target)}`.toLocaleLowerCase(language).includes(filter)))
    .sort(([, a], [, b]) => `${name(a.source)}${name(a.target)}`.localeCompare(`${name(b.source)}${name(b.target)}`, language))
  $('available').replaceChildren(...pairs.map(([key, pair]) => {
    const state = progress.get(key)
    const busy = state?.phase === 'download' || state?.phase === 'store'
    return h('li', {},
      h('div', { className: 'grow' }, h('div', {}, `${name(pair.source)} → ${name(pair.target)}`), h('div', { className: 'meta' }, busy ? t('downloading', { loaded: formatBytes(state.loadedBytes), total: formatBytes(state.totalBytes) }) : state?.phase === 'error' ? t('downloadFailed', { error: state.error ?? '' }) : `${formatBytes(pairDownloadBytes(pair))} · ${formatBytes(pairDiskBytes(pair))}`)),
      busy
        ? h('button', { type: 'button', onclick: () => void request('ui:cancel-download', { pairKey: key }) }, t('cancel'))
        : h('button', { type: 'button', onclick: async () => {
          progress.set(key, { pairKey: key, loadedBytes: 0, totalBytes: pairDownloadBytes(pair), phase: 'download' })
          renderModels()
          try {
            await request('ui:download', { source: pair.source, target: pair.target })
            progress.delete(key)
          } catch (error) {
            progress.set(key, { pairKey: key, loadedBytes: 0, totalBytes: 0, phase: 'error', error: errorMessage(error) })
          }
          await refreshModels()
        } }, state?.phase === 'error' ? t('retry') : t('downloadAction', { size: formatBytes(pairDownloadBytes(pair)) })))
  }))
}

async function refreshModels(): Promise<void> {
  try {
    const models = await request<{ installed: InstalledPair[]; usage: { usage: number | null } }>('ui:models')
    installed = models.installed
    const total = installed.reduce((sum, pair) => sum + pair.bytes, 0)
    $('storage').textContent = t('optionsStorage', { size: formatBytes(total) })
  } catch (error) {
    $('storage').textContent = errorMessage(error)
  }
  renderModels()
}

async function refreshEngine(): Promise<void> {
  const status = await request<{ phase: EnginePhase }>('ui:engine-status').catch(() => ({ phase: 'released' as EnginePhase }))
  $('engine-state').textContent = t('optionsEngineState', { state: t(PHASE_KEYS[status.phase]) })
}

async function start(): Promise<void> {
  localize()
  document.title = t('optionsTitle')
  catalog = parseCatalog(await (await fetch(chrome.runtime.getURL('catalog/models.json'))).json())
  settings = await loadSettings()
  renderSettings()
  await refreshModels()
  await refreshEngine()
}

$('display').addEventListener('click', (event) => {
  const mode = (event.target as HTMLElement).closest('button')?.dataset.mode
  if (mode === 'replace' || mode === 'bilingual') void save({ displayMode: mode })
})
$<HTMLInputElement>('selection-button').addEventListener('change', (event) => void save({ selectionButton: (event.target as HTMLInputElement).checked }))
$<HTMLSelectElement>('idle').addEventListener('change', (event) => void save({ idleSeconds: Number((event.target as HTMLSelectElement).value) }))
$<HTMLFormElement>('site-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $<HTMLInputElement>('site')
  const host = normalizeHost(input.value)
  if (!host) {
    input.setCustomValidity(t('optionsSitePlaceholder'))
    input.reportValidity()
    return
  }
  input.setCustomValidity('')
  input.value = ''
  void save({ neverTranslateSites: [...settings.neverTranslateSites, host] })
})
$<HTMLInputElement>('filter').addEventListener('input', renderModels)
$('delete-all').addEventListener('click', async () => {
  if (!confirm(t('optionsDeleteAllConfirm'))) return
  await request('ui:delete-all-models').catch((error: unknown) => alert(errorMessage(error)))
  progress.clear()
  await refreshModels()
})

onEngineEvents({
  progress(event) {
    if (event.phase === 'done' || event.phase === 'cancelled') progress.delete(event.pairKey)
    else progress.set(event.pairKey, event)
    renderModels()
  },
  phase(phase) {
    $('engine-state').textContent = t('optionsEngineState', { state: t(PHASE_KEYS[phase]) })
  }
})

void start()
