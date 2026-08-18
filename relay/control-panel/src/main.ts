import './styles.css'
import { api, ApiError, jsonBody } from './api'
import { parseRelayRichText, type RelayRichTextInline } from '../../../src/shared/relay-rich-text'
import {
  broadcastInputFrom,
  duplicateBroadcastInput,
  expireBroadcastInput,
  formatDate,
  formatNumber,
  fromDateTimeLocal,
  previewPayload,
  releaseInputFrom,
  toDateTimeLocal
} from './model'
import type {
  AssetItem,
  AuditItem,
  BroadcastAdminItem,
  BroadcastInput,
  BroadcastState,
  BroadcastType,
  DashboardSummary,
  Installation,
  InstallationListResponse,
  ReleaseAdminItem,
  ReleaseInput,
  ReleaseSeverity,
  SessionInfo
} from './types'

type Page = 'dashboard' | 'installations' | 'broadcasts' | 'media' | 'releases' | 'audit'

const broadcastTypes: BroadcastType[] = ['welcome', 'seasonal', 'announcement', 'security', 'update_notice']
const broadcastStates: Array<'all' | BroadcastState> = ['all', 'draft', 'scheduled', 'active', 'expired', 'disabled']
const releaseSeverities: ReleaseSeverity[] = ['optional', 'recommended', 'important', 'critical']
const dashboardRefreshIntervalMs = 30_000
const relayArchitectureLogoUrl = new URL('../../../assets/logos/vast-relay-architecture.png', import.meta.url).href

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, tone: 'quiet' | 'primary' | 'danger' = 'quiet'): HTMLButtonElement {
  const node = element('button', `button button--${tone}`, label)
  node.type = 'button'
  return node
}

function badge(label: string, tone = label): HTMLSpanElement {
  return element('span', `badge badge--${tone.replace(/_/g, '-')}`, label.replace(/_/g, ' '))
}

function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const wrapper = element('label', 'field')
  wrapper.append(element('span', 'field__label', label), control)
  if (hint) wrapper.append(element('span', 'field__hint', hint))
  return wrapper
}

function input(type = 'text'): HTMLInputElement {
  const node = element('input', 'input')
  node.type = type
  return node
}

function select<T extends string>(values: readonly T[]): HTMLSelectElement {
  const node = element('select', 'input')
  for (const value of values) {
    const option = element('option', undefined, value.replace(/_/g, ' '))
    option.value = value
    node.append(option)
  }
  return node
}

function emptyState(title: string, detail: string): HTMLElement {
  const node = element('section', 'empty-state')
  node.append(element('h3', undefined, title), element('p', undefined, detail))
  return node
}

function appendRichTextInline(parent: HTMLElement, content: RelayRichTextInline[]): void {
  for (const node of content) {
    if (node.kind === 'text') {
      parent.append(document.createTextNode(node.value))
      continue
    }
    const inline = element(node.kind === 'strong' ? 'strong' : node.kind === 'emphasis' ? 'em' : 'code')
    inline.textContent = node.value
    parent.append(inline)
  }
}

function renderRichTextPreview(body: string): HTMLElement {
  const container = element('div', 'message-preview__body')
  for (const block of parseRelayRichText(body)) {
    if (block.kind === 'divider') {
      container.append(element('hr'))
      continue
    }
    if (block.kind === 'code-block') {
      const pre = element('pre')
      pre.append(element('code', undefined, block.value))
      container.append(pre)
      continue
    }
    if (block.kind === 'unordered-list' || block.kind === 'ordered-list') {
      const list = element(block.kind === 'ordered-list' ? 'ol' : 'ul')
      for (const item of block.items) {
        const entry = element('li')
        appendRichTextInline(entry, item)
        list.append(entry)
      }
      container.append(list)
      continue
    }
    const tag = block.kind === 'heading'
      ? block.level === 1 ? 'h4' : block.level === 2 ? 'h5' : 'h6'
      : block.kind === 'quote' ? 'blockquote' : 'p'
    const node = element(tag)
    appendRichTextInline(node, block.content)
    container.append(node)
  }
  return container
}

class ControlPanel {
  private readonly root: HTMLElement
  private content = element('section', 'content')
  private toastRegion = element('div', 'toasts')
  private session: SessionInfo | null = null
  private activePage: Page = 'dashboard'
  private broadcasts: BroadcastAdminItem[] = []
  private assets: AssetItem[] = []
  private releases: ReleaseAdminItem[] = []
  private renderNonce = 0
  private dashboardRefreshTimer: number | undefined
  private dashboardRefreshInFlight = false

  constructor(root: HTMLElement) {
    this.root = root
    this.toastRegion.setAttribute('aria-live', 'assertive')
  }

  async start(): Promise<void> {
    this.root.replaceChildren(this.loading('Establishing secure session'))
    try {
      this.session = await api<SessionInfo>('/v1/admin/session')
      this.renderShell()
      await this.navigate('dashboard')
    } catch (error) {
      this.root.replaceChildren(this.failure('The Control Panel could not establish an authenticated session.', error))
    }
  }

  private renderShell(): void {
    if (!this.session) return
    const shell = element('div', 'shell')
    const topbar = element('header', 'topbar')
    const inner = element('div', 'topbar__inner')
    const nav = (side: 'left' | 'right', pages: Array<[Page, string]>): HTMLElement => {
      const navigation = element('nav', `topbar__nav topbar__nav--${side}`)
      navigation.setAttribute('aria-label', `${side === 'left' ? 'Primary' : 'Secondary'} Control Panel navigation`)
      for (const [page, label] of pages) {
        const item = button(label)
        item.className = 'nav-item'
        item.dataset.page = page
        item.addEventListener('click', () => void this.navigate(page))
        navigation.append(item)
      }
      return navigation
    }
    const leftNavigation = nav('left', [
      ['dashboard', 'Overview'],
      ['installations', 'Instances'],
      ['broadcasts', 'Broadcasts']
    ])
    const rightNavigation = nav('right', [
      ['media', 'Media'],
      ['releases', 'Updates'],
      ['audit', 'Audit']
    ])
    const brand = button('')
    brand.className = 'topbar__brand'
    brand.setAttribute('aria-label', 'Vast Relay Architecture overview')
    const brandImage = element('img', 'topbar__logo')
    brandImage.src = relayArchitectureLogoUrl
    brandImage.alt = 'Vast Relay Architecture'
    brand.append(brandImage)
    brand.addEventListener('click', () => void this.navigate('dashboard'))

    const identity = element('details', 'session-menu')
    const identitySummary = element('summary', 'session-menu__summary')
    identitySummary.append(element('span', 'session-menu__status'), element('span', undefined, this.session.environment))
    const identityPanel = element('div', 'session-menu__panel')
    identityPanel.append(
      element('span', 'eyebrow', 'Authenticated'),
      element('strong', undefined, this.session.actor),
      element('span', 'mono', this.session.key_id)
    )
    const logout = element('a', 'identity__logout', 'Sign out')
    logout.href = '/cdn-cgi/access/logout'
    identityPanel.append(logout)
    identity.append(identitySummary, identityPanel)
    rightNavigation.append(identity)

    inner.append(leftNavigation, brand, rightNavigation)
    topbar.append(inner)
    shell.append(topbar, this.content)
    this.root.replaceChildren(shell, this.toastRegion)
  }

  private async navigate(page: Page): Promise<void> {
    this.clearDashboardRefresh()
    this.activePage = page
    for (const item of this.root.querySelectorAll<HTMLButtonElement>('.nav-item')) {
      item.classList.toggle('is-active', item.dataset.page === page)
      if (item.dataset.page === page) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
    }
    const nonce = ++this.renderNonce
    this.content.replaceChildren(this.loading(`Loading ${page}`))
    try {
      if (page === 'dashboard') await this.renderDashboard(nonce)
      else if (page === 'installations') await this.renderInstallations(nonce)
      else if (page === 'broadcasts') await this.renderBroadcasts(nonce)
      else if (page === 'media') await this.renderMedia(nonce)
      else if (page === 'releases') await this.renderReleases(nonce)
      else await this.renderAudit(nonce)
    } catch (error) {
      if (nonce === this.renderNonce) this.content.replaceChildren(this.failure(`Unable to load ${page}.`, error))
    } finally {
      if (page === 'dashboard' && nonce === this.renderNonce) this.scheduleDashboardRefresh()
    }
  }

  private clearDashboardRefresh(): void {
    if (this.dashboardRefreshTimer === undefined) return
    window.clearTimeout(this.dashboardRefreshTimer)
    this.dashboardRefreshTimer = undefined
  }

  private scheduleDashboardRefresh(): void {
    this.clearDashboardRefresh()
    if (this.activePage !== 'dashboard') return
    this.dashboardRefreshTimer = window.setTimeout(() => {
      this.dashboardRefreshTimer = undefined
      void this.refreshDashboard()
    }, dashboardRefreshIntervalMs)
  }

  private async refreshDashboard(notifyFailure = false): Promise<void> {
    if (this.activePage !== 'dashboard' || this.dashboardRefreshInFlight) return
    this.clearDashboardRefresh()
    this.dashboardRefreshInFlight = true
    const nonce = ++this.renderNonce
    try {
      await this.renderDashboard(nonce)
    } catch {
      if (notifyFailure && this.activePage === 'dashboard' && nonce === this.renderNonce) {
        this.toast('Dashboard refresh failed safely.', true)
      }
    } finally {
      this.dashboardRefreshInFlight = false
      if (this.activePage === 'dashboard' && nonce === this.renderNonce) this.scheduleDashboardRefresh()
    }
  }

  private pageHeader(eyebrow: string, title: string, detail: string, action?: HTMLElement): HTMLElement {
    const header = element('header', 'page-header')
    const copy = element('div')
    copy.append(element('span', 'eyebrow', eyebrow), element('h1', undefined, title), element('p', undefined, detail))
    header.append(copy)
    if (action) header.append(action)
    return header
  }

  private async renderDashboard(nonce: number): Promise<void> {
    const summary = await api<DashboardSummary>('/v1/admin/dashboard')
    if (nonce !== this.renderNonce) return
    const fragment = document.createDocumentFragment()
    const refresh = button('Refresh data')
    refresh.addEventListener('click', () => void this.refreshDashboard(true))
    fragment.append(this.pageHeader('Vast Relay', 'Overview', `Aggregate installation health · ${formatDate(summary.generated_at)}`, refresh))
    const metrics = element('section', 'metric-grid')
    const cards: Array<[string, number, string]> = [
      ['Total installations', summary.totals.installations, 'All known installations'],
      ['Active · 24h', summary.totals.active_24h, `${formatNumber(summary.totals.new_24h)} new`],
      ['Active · 7d', summary.totals.active_7d, `${formatNumber(summary.totals.new_7d)} new`],
      ['Active · 30d', summary.totals.active_30d, `${formatNumber(summary.totals.new_30d)} new`]
    ]
    for (const [label, value, meta] of cards) {
      const card = element('article', 'metric-card')
      card.append(element('span', 'metric-card__label', label), element('strong', undefined, formatNumber(value)), element('span', undefined, meta))
      metrics.append(card)
    }
    fragment.append(metrics)

    const split = element('section', 'dashboard-split')
    const versions = element('article', 'panel')
    versions.append(element('h2', undefined, 'Version distribution'))
    if (summary.versions.length === 0) versions.append(emptyState('No versions yet', 'Version distribution appears after the first check-in.'))
    else {
      const list = element('div', 'version-list')
      for (const item of summary.versions.slice(0, 12)) {
        const row = element('div', 'version-row')
        const label = element('div', 'version-row__label')
        label.append(element('strong', 'mono', item.version), element('span', undefined, formatNumber(item.count)))
        const track = element('progress', 'version-row__track')
        track.max = 100
        track.value = item.percentage
        row.append(label, track, element('span', 'version-row__percent', `${item.percentage.toFixed(1)}%`))
        list.append(row)
      }
      versions.append(list)
    }

    const operational = element('article', 'panel')
    operational.append(element('h2', undefined, 'Launch aggregate'))
    const detail = element('dl', 'definition-list')
    for (const [label, value] of [
      ['Average', formatNumber(summary.launch_counts.average)],
      ['Maximum', formatNumber(summary.launch_counts.maximum)],
      ['Cumulative', formatNumber(summary.launch_counts.total)]
    ]) {
      detail.append(element('dt', undefined, label), element('dd', 'mono', value))
    }
    const browse = button('Browse all instances')
    browse.classList.add('panel__action')
    browse.addEventListener('click', () => void this.navigate('installations'))
    operational.append(detail, browse)
    split.append(versions, operational)
    fragment.append(split)
    this.content.replaceChildren(fragment)
  }

  private async renderInstallations(nonce: number): Promise<void> {
    const summary = await api<DashboardSummary>('/v1/admin/dashboard')
    if (nonce !== this.renderNonce) return
    const fragment = document.createDocumentFragment()
    fragment.append(this.pageHeader(
      'Minimal registry',
      'Vast instances',
      'Every known Relay installation. Only the five documented installation fields are available here.'
    ))

    const controls = element('form', 'instances-toolbar')
    const exactId = input('search')
    exactId.placeholder = 'Exact installation UUID'
    exactId.maxLength = 36
    exactId.autocomplete = 'off'
    exactId.setAttribute('aria-label', 'Find an exact installation ID')
    const activity = select(['all', '24h', '7d', '30d'] as const)
    activity.options[0].textContent = 'Any activity'
    activity.options[1].textContent = 'Active in 24 hours'
    activity.options[2].textContent = 'Active in 7 days'
    activity.options[3].textContent = 'Active in 30 days'
    activity.setAttribute('aria-label', 'Filter instances by recent activity')
    const version = element('select', 'input')
    const allVersions = element('option', undefined, 'All versions')
    allVersions.value = ''
    version.append(allVersions)
    for (const item of summary.versions) {
      const option = element('option', undefined, `${item.version} · ${formatNumber(item.count)}`)
      option.value = item.version
      version.append(option)
    }
    version.setAttribute('aria-label', 'Filter instances by Vast version')
    const apply = button('Apply filters', 'primary')
    apply.type = 'submit'
    const reset = button('Reset')
    controls.append(exactId, activity, version, apply, reset)

    const resultHeader = element('div', 'instances-result-header')
    const resultCount = element('span', 'instances-result-count', 'Loading instances…')
    const privacy = element('span', 'instances-privacy', 'No IP, hardware, account or browsing data')
    resultHeader.append(resultCount, privacy)
    const resultRegion = element('section', 'instances-result')
    resultRegion.setAttribute('aria-live', 'polite')
    const pager = element('nav', 'instances-pager')
    pager.setAttribute('aria-label', 'Installation pages')
    const previous = button('Previous')
    const pageLabel = element('span', 'mono')
    const next = button('Next')
    pager.append(previous, pageLabel, next)
    fragment.append(controls, resultHeader, resultRegion, pager)
    this.content.replaceChildren(fragment)

    let cursors: Array<string | null> = [null]
    let pageIndex = 0
    let loading = false
    const load = async (): Promise<void> => {
      if (loading || nonce !== this.renderNonce) return
      loading = true
      previous.disabled = true
      next.disabled = true
      resultRegion.classList.add('is-loading')
      try {
        const params = new URLSearchParams({ limit: '25', activity: activity.value })
        if (version.value) params.set('version', version.value)
        if (exactId.value.trim()) params.set('install_id', exactId.value.trim())
        const cursor = cursors[pageIndex]
        if (cursor) params.set('cursor', cursor)
        const response = await api<InstallationListResponse>(`/v1/admin/installations?${params.toString()}`)
        if (nonce !== this.renderNonce) return
        resultCount.textContent = `${formatNumber(response.total)} ${response.total === 1 ? 'instance' : 'instances'}`
        pageLabel.textContent = `Page ${pageIndex + 1}`
        previous.disabled = pageIndex === 0
        next.disabled = response.next_cursor === null
        if (response.next_cursor) cursors[pageIndex + 1] = response.next_cursor
        else cursors.splice(pageIndex + 1)
        this.renderInstallationTable(resultRegion, response.items)
      } catch (error) {
        resultRegion.replaceChildren(this.failure('Unable to load the installation registry.', error))
      } finally {
        loading = false
        resultRegion.classList.remove('is-loading')
      }
    }
    controls.addEventListener('submit', (event) => {
      event.preventDefault()
      cursors = [null]
      pageIndex = 0
      void load()
    })
    reset.addEventListener('click', () => {
      controls.reset()
      cursors = [null]
      pageIndex = 0
      void load()
    })
    previous.addEventListener('click', () => {
      if (pageIndex === 0) return
      pageIndex -= 1
      void load()
    })
    next.addEventListener('click', () => {
      if (!cursors[pageIndex + 1]) return
      pageIndex += 1
      void load()
    })
    await load()
  }

  private renderInstallationTable(region: HTMLElement, installations: Installation[]): void {
    if (installations.length === 0) {
      region.replaceChildren(emptyState('No matching instances', 'Change the filters or verify the exact installation UUID.'))
      return
    }
    const wrapper = element('div', 'instances-table-wrap')
    const table = element('table', 'instances-table')
    const head = element('thead')
    const headRow = element('tr')
    for (const label of ['Instance', 'Version', 'First seen', 'Last seen', 'Launches', '']) headRow.append(element('th', undefined, label))
    head.append(headRow)
    const body = element('tbody')
    for (const installation of installations) {
      const row = element('tr')
      const idCell = element('td')
      const idButton = button(installation.install_id)
      idButton.className = 'instance-id mono'
      idButton.title = 'Open installation details'
      idButton.addEventListener('click', () => this.openInstallationDetails(installation))
      idCell.append(idButton)
      const versionCell = element('td')
      versionCell.append(badge(installation.current_version, 'version'))
      const firstSeen = element('td')
      firstSeen.append(element('time', undefined, formatDate(installation.first_seen)))
      const lastSeen = element('td')
      lastSeen.append(element('time', undefined, formatDate(installation.last_seen)))
      const launches = element('td', 'mono', formatNumber(installation.launch_count))
      const actionCell = element('td')
      const details = button('Details')
      details.addEventListener('click', () => this.openInstallationDetails(installation))
      actionCell.append(details)
      row.append(idCell, versionCell, firstSeen, lastSeen, launches, actionCell)
      body.append(row)
    }
    table.append(head, body)
    wrapper.append(table)
    region.replaceChildren(wrapper)
  }

  private openInstallationDetails(installation: Installation): void {
    const dialog = element('dialog', 'dialog dialog--instance')
    const panel = element('section', 'instance-detail')
    const header = element('header', 'instance-detail__header')
    const heading = element('div')
    heading.append(element('span', 'eyebrow', 'Relay installation'), element('h2', undefined, 'Instance details'))
    const close = button('Close')
    close.addEventListener('click', () => dialog.close())
    header.append(heading, close)
    const status = element('div', 'instance-detail__status')
    status.append(badge(installation.current_version, 'version'), element('span', undefined, `Last contact ${formatDate(installation.last_seen)}`))
    const values = element('dl', 'instance-detail__values')
    const rows: Array<[string, string]> = [
      ['Installation ID', installation.install_id],
      ['Current version', installation.current_version],
      ['First seen', formatDate(installation.first_seen)],
      ['Last seen', formatDate(installation.last_seen)],
      ['Launch count', formatNumber(installation.launch_count)]
    ]
    for (const [name, value] of rows) values.append(element('dt', undefined, name), element('dd', 'mono', value))
    const actions = element('footer', 'instance-detail__actions')
    const copyId = button('Copy installation ID', 'primary')
    copyId.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(installation.install_id)
        copyId.textContent = 'Copied'
      } catch {
        this.toast('Clipboard access was unavailable.', true)
      }
    })
    actions.append(copyId)
    panel.append(header, status, values, actions)
    dialog.append(panel)
    dialog.addEventListener('close', () => dialog.remove())
    document.body.append(dialog)
    dialog.showModal()
  }

  private async loadAssets(): Promise<void> {
    const response = await api<{ items: AssetItem[] }>('/v1/admin/assets')
    this.assets = response.items
  }

  private async renderBroadcasts(nonce: number): Promise<void> {
    const [broadcasts] = await Promise.all([
      api<{ items: BroadcastAdminItem[] }>('/v1/admin/broadcasts'),
      this.loadAssets()
    ])
    if (nonce !== this.renderNonce) return
    this.broadcasts = broadcasts.items
    const create = button('New broadcast', 'primary')
    create.addEventListener('click', () => void this.openBroadcastEditor())
    const fragment = document.createDocumentFragment()
    fragment.append(this.pageHeader('Signed content', 'Broadcasts', 'Create, schedule, preview and stop structured Relay messages.', create))
    if (this.broadcasts.length === 0) fragment.append(emptyState('No broadcasts', 'Production should remain empty until a reviewed message is intentionally published.'))
    else {
      const toolbar = element('section', 'broadcast-toolbar')
      const search = input('search')
      search.placeholder = 'Search title, body or ID'
      search.setAttribute('aria-label', 'Search broadcasts')
      const stateFilter = select(broadcastStates)
      stateFilter.setAttribute('aria-label', 'Filter broadcasts by state')
      const status = element('span', 'broadcast-toolbar__status')
      const counters = element('div', 'broadcast-summary')
      counters.append(element('span', undefined, `${this.broadcasts.length} total`))
      for (const state of broadcastStates.slice(1)) {
        const count = this.broadcasts.filter((item) => item.state === state).length
        if (count > 0) counters.append(element('span', undefined, `${count} ${state}`))
      }
      const filters = element('div', 'broadcast-toolbar__filters')
      filters.append(search, stateFilter)
      toolbar.append(counters, filters, status)
      const list = element('section', 'record-list')
      const renderFiltered = (): void => {
        const query = search.value.trim().toLocaleLowerCase()
        const selectedState = stateFilter.value as 'all' | BroadcastState
        const visible = this.broadcasts.filter((item) => {
          if (selectedState !== 'all' && item.state !== selectedState) return false
          if (!query) return true
          return [item.payload.title, item.payload.body, item.payload.id, item.payload.type]
            .some((value) => value.toLocaleLowerCase().includes(query))
        })
        status.textContent = `${visible.length} shown`
        list.replaceChildren()
        if (visible.length === 0) {
          list.append(emptyState('No matching broadcasts', 'Adjust the search or state filter.'))
          return
        }
        for (const item of visible) list.append(this.broadcastRecord(item))
      }
      search.addEventListener('input', renderFiltered)
      stateFilter.addEventListener('change', renderFiltered)
      renderFiltered()
      fragment.append(toolbar, list)
    }
    this.content.replaceChildren(fragment)
  }

  private broadcastRecord(item: BroadcastAdminItem): HTMLElement {
    const row = element('article', 'record')
    const main = element('div', 'record__main')
    const title = element('div', 'record__title')
    title.append(element('strong', undefined, item.payload.title), badge(item.payload.type, item.payload.type), badge(item.state, item.state))
    main.append(title, element('p', undefined, item.payload.body))
    const meta = element('div', 'record__meta')
    meta.append(
      element('span', undefined, `Priority ${item.payload.priority}`),
      element('span', undefined, formatDate(item.payload.active_from)),
      element('span', undefined, item.payload.active_until ? `until ${formatDate(item.payload.active_until)}` : 'no expiry'),
      element('span', undefined, `created ${formatDate(item.payload.created_at)}`),
      element('span', 'mono', item.payload.id),
      element('span', 'mono', `r${item.revision} · ${item.key_id}`)
    )
    main.append(meta)
    const actions = element('div', 'record__actions')
    const edit = button('Edit')
    edit.addEventListener('click', () => void this.openBroadcastEditor(item))
    const duplicate = button('Duplicate')
    duplicate.addEventListener('click', () => void this.openBroadcastEditor(undefined, duplicateBroadcastInput(item)))
    const toggle = button(item.payload.enabled ? 'Disable' : 'Enable', item.payload.enabled ? 'danger' : 'quiet')
    toggle.addEventListener('click', () => void this.toggleBroadcast(item))
    const expire = button('Expire')
    expire.disabled = item.state !== 'active' && item.state !== 'scheduled'
    expire.addEventListener('click', () => void this.saveBroadcast(item, expireBroadcastInput(item), 'Broadcast expired.'))
    const remove = button('Delete', 'danger')
    const canDelete = item.state === 'draft' || item.state === 'expired' || item.state === 'disabled'
    remove.disabled = !canDelete
    remove.title = canDelete ? 'Permanently delete this old broadcast' : 'Disable or expire this broadcast before deleting it'
    remove.addEventListener('click', () => void this.deleteBroadcast(item))
    actions.append(edit, duplicate, toggle, expire, remove)
    row.append(main, actions)
    return row
  }

  private async toggleBroadcast(item: BroadcastAdminItem): Promise<void> {
    const payload = broadcastInputFrom(item)
    payload.draft = false
    payload.enabled = !item.payload.enabled
    await this.saveBroadcast(item, payload, payload.enabled ? 'Broadcast enabled.' : 'Broadcast disabled.')
  }

  private async saveBroadcast(item: BroadcastAdminItem, payload: BroadcastInput, success: string): Promise<void> {
    try {
      await api(`/v1/admin/broadcasts/${encodeURIComponent(item.payload.id)}`, {
        method: 'PUT',
        body: jsonBody(payload),
        revision: item.revision
      })
      this.toast(success)
      await this.navigate('broadcasts')
    } catch (error) {
      this.toast(this.errorMessage(error), true)
    }
  }

  private async deleteBroadcast(item: BroadcastAdminItem): Promise<void> {
    if (item.state === 'active' || item.state === 'scheduled') return
    const confirmed = await this.confirmDestructive(
      'Delete broadcast permanently?',
      `“${item.payload.title}” will be removed from D1. Its audit entry remains available.`,
      'Delete broadcast'
    )
    if (!confirmed) return
    try {
      await api(`/v1/admin/broadcasts/${encodeURIComponent(item.payload.id)}`, {
        method: 'DELETE',
        revision: item.revision
      })
      this.toast('Broadcast deleted. The audit record was preserved.')
      await this.navigate('broadcasts')
    } catch (error) {
      this.toast(this.errorMessage(error), true)
    }
  }

  private async openBroadcastEditor(existing?: BroadcastAdminItem, seed?: BroadcastInput): Promise<void> {
    if (this.assets.length === 0) await this.loadAssets().catch(() => undefined)
    const initial: BroadcastInput = seed ?? (existing ? broadcastInputFrom(existing) : {
      type: 'announcement',
      title: '',
      body: '',
      media_id: null,
      action_label: null,
      action_url: null,
      min_version: null,
      max_version: null,
      active_from: new Date().toISOString(),
      active_until: null,
      priority: 100,
      enabled: false,
      draft: true
    })
    const dialog = element('dialog', 'dialog dialog--wide')
    const form = element('form', 'editor')
    form.method = 'dialog'
    const heading = element('header', 'dialog__header')
    heading.append(element('div', undefined, existing ? 'Edit signed broadcast' : 'Create signed broadcast'))
    const close = button('Close')
    close.addEventListener('click', () => dialog.close())
    heading.append(close)
    const fields = element('section', 'editor__fields')
    const type = select(broadcastTypes)
    type.value = initial.type
    const title = input()
    title.required = true
    title.maxLength = 160
    title.value = initial.title
    const body = element('textarea', 'input input--area')
    body.required = true
    body.maxLength = 4000
    body.value = initial.body
    const bodyControl = element('div', 'body-editor')
    const formatToolbar = element('div', 'format-toolbar')
    formatToolbar.setAttribute('aria-label', 'Message formatting')
    const replaceSelection = (prefix: string, suffix: string, placeholder: string): void => {
      const start = body.selectionStart
      const end = body.selectionEnd
      const selected = body.value.slice(start, end) || placeholder
      const replacement = `${prefix}${selected}${suffix}`
      if (body.value.length - (end - start) + replacement.length > body.maxLength) {
        this.toast('The formatted body would exceed 4,000 characters.', true)
        return
      }
      body.setRangeText(replacement, start, end, 'end')
      body.setSelectionRange(start + prefix.length, start + prefix.length + selected.length)
      body.dispatchEvent(new Event('input', { bubbles: true }))
      body.focus()
    }
    const prefixLines = (prefix: string, ordered = false): void => {
      const start = body.selectionStart
      const end = body.selectionEnd
      const lineStart = body.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      const nextBreak = body.value.indexOf('\n', end)
      const lineEnd = nextBreak === -1 ? body.value.length : nextBreak
      const selected = body.value.slice(lineStart, lineEnd) || 'Item'
      const replacement = selected.split('\n').map((line, index) => `${ordered ? `${index + 1}. ` : prefix}${line || 'Item'}`).join('\n')
      if (body.value.length - (lineEnd - lineStart) + replacement.length > body.maxLength) {
        this.toast('The formatted body would exceed 4,000 characters.', true)
        return
      }
      body.setRangeText(replacement, lineStart, lineEnd, 'select')
      body.dispatchEvent(new Event('input', { bubbles: true }))
      body.focus()
    }
    const formatButton = (label: string, titleText: string, action: () => void): HTMLButtonElement => {
      const control = button(label)
      control.className = 'format-button'
      control.title = titleText
      control.setAttribute('aria-label', titleText)
      control.addEventListener('click', action)
      return control
    }
    formatToolbar.append(
      formatButton('H1', 'Large heading', () => prefixLines('# ')),
      formatButton('H2', 'Medium heading', () => prefixLines('## ')),
      formatButton('B', 'Bold', () => replaceSelection('**', '**', 'bold text')),
      formatButton('I', 'Italic', () => replaceSelection('*', '*', 'italic text')),
      formatButton('•', 'Bulleted list', () => prefixLines('- ')),
      formatButton('1.', 'Numbered list', () => prefixLines('', true)),
      formatButton('❯', 'Quote', () => prefixLines('> ')),
      formatButton('`', 'Inline code', () => replaceSelection('`', '`', 'code')),
      formatButton('```', 'Code block', () => replaceSelection('```\n', '\n```', 'code block'))
    )
    bodyControl.append(formatToolbar, body)
    const media = element('select', 'input')
    const none = element('option', undefined, 'No media')
    none.value = ''
    media.append(none)
    for (const asset of this.assets) {
      const option = element('option', undefined, `${asset.id} · ${this.bytes(asset.size)}`)
      option.value = asset.id
      media.append(option)
    }
    media.value = initial.media_id ?? ''
    const actionLabel = input()
    actionLabel.maxLength = 80
    actionLabel.value = initial.action_label ?? ''
    const actionUrl = input('url')
    actionUrl.maxLength = 2048
    actionUrl.placeholder = 'https://…'
    actionUrl.value = initial.action_url ?? ''
    const minVersion = input()
    minVersion.placeholder = '0.1.4'
    minVersion.value = initial.min_version ?? ''
    const maxVersion = input()
    maxVersion.placeholder = 'Optional'
    maxVersion.value = initial.max_version ?? ''
    const activeFrom = input('datetime-local')
    activeFrom.required = true
    activeFrom.value = toDateTimeLocal(initial.active_from)
    const activeUntil = input('datetime-local')
    activeUntil.value = toDateTimeLocal(initial.active_until)
    if (!initial.active_until) activeUntil.value = ''
    const priority = input('number')
    priority.min = '0'
    priority.max = '1000'
    priority.required = true
    priority.value = String(initial.priority)
    const draft = input('checkbox')
    draft.checked = Boolean(initial.draft)
    const enabled = input('checkbox')
    enabled.checked = initial.enabled
    draft.addEventListener('change', () => { if (draft.checked) enabled.checked = false })
    enabled.addEventListener('change', () => { if (enabled.checked) draft.checked = false })
    fields.append(
      field('Type', type),
      field('Title', title, '160 characters maximum'),
      field('Body', bodyControl, 'Safe formatting only: headings, bold, italic, lists, quotes and code. HTML is always displayed as text.'),
      field('Media', media, 'Optional signed SHA-256 reference'),
      field('Action label', actionLabel),
      field('Action URL', actionUrl, 'HTTPS only; opened only after user action'),
      field('Minimum version', minVersion),
      field('Maximum version', maxVersion),
      field('Starts', activeFrom),
      field('Ends', activeUntil),
      field('Priority', priority),
      field('Keep as draft', draft),
      field('Enable delivery', enabled)
    )
    const preview = element('aside', 'editor__preview')
    preview.append(element('span', 'eyebrow', 'Local preview'))
    const previewStage = element('div', 'message-preview-stage')
    const previewCard = element('article', 'message-preview')
    const refreshPreview = (): void => {
      const current = previewPayload({
        ...initial,
        type: type.value as BroadcastType,
        title: title.value || 'Untitled message',
        body: body.value || 'Message copy appears here.',
        action_label: actionLabel.value || null,
        action_url: actionUrl.value || null
      })
      previewCard.dataset.type = current.type
      const previewTitle = element('h3', undefined, current.title)
      const previewBody = renderRichTextPreview(current.body)
      const nodes: HTMLElement[] = []
      if (media.value) {
        const previewMedia = element('img', 'message-preview__media')
        previewMedia.alt = ''
        previewMedia.src = `/v1/admin/assets/${encodeURIComponent(media.value)}/content`
        nodes.push(previewMedia)
      }
      nodes.push(previewTitle, previewBody)
      previewCard.replaceChildren(...nodes)
      if (current.action) previewCard.append(button(current.action.label, 'primary'))
    }
    for (const control of [type, title, body, media, actionLabel, actionUrl]) control.addEventListener('input', refreshPreview)
    refreshPreview()
    previewStage.append(previewCard)
    preview.append(previewStage, element('p', 'muted', 'Approximation only. Vast owns final client rendering and verifies the same structured payload.'))
    const actions = element('footer', 'dialog__actions')
    const save = button(existing ? 'Save and re-sign' : 'Create broadcast', 'primary')
    save.type = 'submit'
    actions.append(save)
    form.append(heading, element('div', 'editor__layout'), actions)
    const layout = form.querySelector<HTMLElement>('.editor__layout')
    layout?.append(fields, preview)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const start = fromDateTimeLocal(activeFrom.value)
      const end = fromDateTimeLocal(activeUntil.value)
      if (!start || (activeUntil.value && !end)) {
        this.toast('Use valid start and end times.', true)
        return
      }
      const payload: BroadcastInput = {
        ...(existing ? { id: existing.payload.id } : {}),
        draft: draft.checked,
        type: type.value as BroadcastType,
        title: title.value,
        body: body.value,
        media_id: media.value || null,
        action_label: actionLabel.value || null,
        action_url: actionUrl.value || null,
        min_version: minVersion.value || null,
        max_version: maxVersion.value || null,
        active_from: start,
        active_until: end,
        priority: Number(priority.value),
        enabled: enabled.checked
      }
      save.disabled = true
      try {
        if (existing) {
          await api(`/v1/admin/broadcasts/${encodeURIComponent(existing.payload.id)}`, {
            method: 'PUT', body: jsonBody(payload), revision: existing.revision
          })
        } else {
          await api('/v1/admin/broadcasts', { method: 'POST', body: jsonBody(payload) })
        }
        dialog.close()
        this.toast(existing ? 'Broadcast updated and freshly signed.' : 'Broadcast created and signed.')
        await this.navigate('broadcasts')
      } catch (error) {
        save.disabled = false
        this.toast(this.errorMessage(error), true)
      }
    })
    dialog.append(form)
    dialog.addEventListener('close', () => dialog.remove())
    document.body.append(dialog)
    dialog.showModal()
  }

  private async renderMedia(nonce: number): Promise<void> {
    await this.loadAssets()
    if (nonce !== this.renderNonce) return
    const upload = button('Upload image', 'primary')
    const file = input('file')
    file.accept = 'image/png,image/webp,image/gif'
    file.hidden = true
    upload.addEventListener('click', () => file.click())
    file.addEventListener('change', () => void this.uploadMedia(file))
    const action = element('div')
    action.append(upload, file)
    const fragment = document.createDocumentFragment()
    fragment.append(this.pageHeader('Private R2', 'Media', 'Validated, immutable image assets with signed integrity metadata.', action))
    if (this.assets.length === 0) fragment.append(emptyState('No media', 'Upload a PNG, WEBP or GIF up to 2 MiB.'))
    else {
      const grid = element('section', 'media-grid')
      for (const asset of this.assets) {
        const card = element('article', 'media-card')
        const image = element('img', 'media-card__image')
        image.alt = ''
        image.loading = 'lazy'
        image.src = `/v1/admin/assets/${encodeURIComponent(asset.id)}/content`
        const copy = element('div', 'media-card__copy')
        copy.append(
          element('strong', 'mono', asset.id),
          element('span', undefined, `${asset.mime} · ${this.bytes(asset.size)}`),
          element('span', 'mono digest', asset.sha256),
          element('span', undefined, `${asset.reference_count} broadcast reference${asset.reference_count === 1 ? '' : 's'}`)
        )
        const remove = button('Delete', 'danger')
        remove.disabled = asset.reference_count > 0
        remove.addEventListener('click', () => void this.deleteMedia(asset))
        card.append(image, copy, remove)
        grid.append(card)
      }
      fragment.append(grid)
    }
    this.content.replaceChildren(fragment)
  }

  private async uploadMedia(fileInput: HTMLInputElement): Promise<void> {
    const file = fileInput.files?.[0]
    if (!file) return
    if (!['image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      this.toast('Choose a PNG, WEBP or GIF no larger than 2 MiB.', true)
      return
    }
    try {
      await api('/v1/admin/assets', { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
      this.toast('Asset validated and uploaded.')
      await this.navigate('media')
    } catch (error) {
      this.toast(this.errorMessage(error), true)
    } finally {
      fileInput.value = ''
    }
  }

  private async deleteMedia(asset: AssetItem): Promise<void> {
    if (!await this.confirmDestructive(
      'Delete media permanently?',
      `${asset.id} will be removed from private R2. This cannot be undone.`,
      'Delete media'
    )) return
    try {
      await api(`/v1/admin/assets/${encodeURIComponent(asset.id)}`, { method: 'DELETE' })
      this.toast('Asset deleted.')
      await this.navigate('media')
    } catch (error) {
      this.toast(this.errorMessage(error), true)
    }
  }

  private confirmDestructive(title: string, detail: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = element('dialog', 'dialog dialog--confirm')
      const content = element('section', 'confirm-dialog')
      content.append(element('span', 'eyebrow', 'Permanent action'), element('h2', undefined, title), element('p', undefined, detail))
      const actions = element('div', 'confirm-dialog__actions')
      const cancel = button('Cancel')
      const confirm = button(confirmLabel, 'danger')
      cancel.addEventListener('click', () => dialog.close('cancel'))
      confirm.addEventListener('click', () => dialog.close('confirm'))
      actions.append(cancel, confirm)
      content.append(actions)
      dialog.append(content)
      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'confirm'
        dialog.remove()
        resolve(accepted)
      }, { once: true })
      document.body.append(dialog)
      dialog.showModal()
      confirm.focus()
    })
  }

  private async renderReleases(nonce: number): Promise<void> {
    const response = await api<{ items: ReleaseAdminItem[] }>('/v1/admin/releases')
    if (nonce !== this.renderNonce) return
    this.releases = response.items
    const create = button('New update notice', 'primary')
    create.addEventListener('click', () => void this.openReleaseEditor())
    const fragment = document.createDocumentFragment()
    fragment.append(this.pageHeader('Updater boundary', 'Update notices', 'Signed availability metadata only. Package trust remains separate.', create))
    if (this.releases.length === 0) fragment.append(emptyState('No update notices', 'No package is uploaded or authorized by Vast Relay.'))
    else {
      const list = element('section', 'record-list')
      for (const item of this.releases) {
        const row = element('article', 'record')
        const main = element('div', 'record__main')
        const title = element('div', 'record__title')
        title.append(element('strong', undefined, item.payload.title), badge(item.payload.severity, item.payload.severity), badge(item.state, item.state))
        main.append(title, element('p', undefined, item.payload.notes))
        const meta = element('div', 'record__meta')
        meta.append(element('span', 'mono', item.payload.version), element('span', undefined, formatDate(item.payload.published_at)), element('span', 'mono', `r${item.revision} · ${item.key_id}`))
        main.append(meta)
        const actions = element('div', 'record__actions')
        const edit = button('Edit')
        edit.addEventListener('click', () => void this.openReleaseEditor(item))
        actions.append(edit)
        if (item.payload.severity !== 'critical' || item.payload.enabled) {
          const toggle = button(item.payload.enabled ? 'Disable' : 'Enable', item.payload.enabled ? 'danger' : 'quiet')
          toggle.addEventListener('click', () => void this.toggleRelease(item))
          actions.append(toggle)
        } else {
          const review = button('Review critical')
          review.addEventListener('click', () => void this.openReleaseEditor(item))
          actions.append(review)
        }
        row.append(main, actions)
        list.append(row)
      }
      fragment.append(list)
    }
    this.content.replaceChildren(fragment)
  }

  private async toggleRelease(item: ReleaseAdminItem): Promise<void> {
    const payload = releaseInputFrom(item)
    payload.enabled = !payload.enabled
    try {
      await api(`/v1/admin/releases/${encodeURIComponent(item.payload.version)}`, {
        method: 'PUT', body: jsonBody(payload), revision: item.revision
      })
      this.toast(payload.enabled ? 'Update notice enabled.' : 'Update notice disabled.')
      await this.navigate('releases')
    } catch (error) {
      this.toast(this.errorMessage(error), true)
    }
  }

  private async openReleaseEditor(existing?: ReleaseAdminItem): Promise<void> {
    const initial: ReleaseInput = existing ? releaseInputFrom(existing) : {
      version: '',
      release_url: 'https://github.com/vast-browser/vast/releases',
      severity: 'optional',
      min_supported_version: null,
      title: '',
      notes: '',
      published_at: new Date().toISOString(),
      enabled: false
    }
    const dialog = element('dialog', 'dialog')
    const form = element('form', 'editor editor--single')
    const heading = element('header', 'dialog__header')
    heading.append(element('div', undefined, existing ? 'Edit update notice' : 'Create update notice'))
    const close = button('Close')
    close.addEventListener('click', () => dialog.close())
    heading.append(close)
    const fields = element('section', 'editor__fields')
    const version = input()
    version.required = true
    version.maxLength = 64
    version.value = initial.version
    version.disabled = Boolean(existing)
    const releaseUrl = input('url')
    releaseUrl.required = true
    releaseUrl.maxLength = 2048
    releaseUrl.value = initial.release_url
    const severity = select(releaseSeverities)
    severity.value = initial.severity
    const minimum = input()
    minimum.placeholder = 'Optional'
    minimum.value = initial.min_supported_version ?? ''
    const title = input()
    title.required = true
    title.maxLength = 160
    title.value = initial.title
    const notes = element('textarea', 'input input--area')
    notes.required = true
    notes.maxLength = 2000
    notes.value = initial.notes
    const published = input('datetime-local')
    published.required = true
    published.value = toDateTimeLocal(initial.published_at)
    const enabled = input('checkbox')
    enabled.checked = initial.enabled
    const confirmation = input()
    confirmation.placeholder = 'Type PUBLISH CRITICAL'
    confirmation.autocomplete = 'off'
    const confirmationField = field('Critical confirmation', confirmation, 'Required only when enabling a critical notice.')
    const updateConfirmation = (): void => {
      confirmationField.hidden = severity.value !== 'critical' || !enabled.checked
    }
    severity.addEventListener('change', updateConfirmation)
    enabled.addEventListener('change', updateConfirmation)
    updateConfirmation()
    fields.append(
      field('Version', version),
      field('Release URL', releaseUrl, 'HTTPS notice target; never package execution authority'),
      field('Severity', severity),
      field('Minimum supported version', minimum),
      field('Title', title),
      field('Short message', notes),
      field('Published at', published),
      field('Enable notice', enabled),
      confirmationField
    )
    const actions = element('footer', 'dialog__actions')
    const save = button(existing ? 'Save and re-sign' : 'Create notice', 'primary')
    save.type = 'submit'
    actions.append(save)
    form.append(heading, fields, actions)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const publishedAt = fromDateTimeLocal(published.value)
      const isCritical = severity.value === 'critical' && enabled.checked
      if (!publishedAt) {
        this.toast('Use a valid publication time.', true)
        return
      }
      if (isCritical && confirmation.value !== 'PUBLISH CRITICAL') {
        this.toast('Type PUBLISH CRITICAL to enable this notice.', true)
        return
      }
      const payload: ReleaseInput = {
        version: initial.version || version.value,
        release_url: releaseUrl.value,
        severity: severity.value as ReleaseSeverity,
        min_supported_version: minimum.value || null,
        title: title.value,
        notes: notes.value,
        published_at: publishedAt,
        enabled: enabled.checked
      }
      save.disabled = true
      try {
        if (existing) {
          await api(`/v1/admin/releases/${encodeURIComponent(existing.payload.version)}`, {
            method: 'PUT', body: jsonBody(payload), revision: existing.revision, criticalConfirmation: isCritical
          })
        } else {
          await api('/v1/admin/releases', {
            method: 'POST', body: jsonBody(payload), criticalConfirmation: isCritical
          })
        }
        dialog.close()
        this.toast(existing ? 'Update notice re-signed.' : 'Update notice created and signed.')
        await this.navigate('releases')
      } catch (error) {
        save.disabled = false
        this.toast(this.errorMessage(error), true)
      }
    })
    dialog.append(form)
    dialog.addEventListener('close', () => dialog.remove())
    document.body.append(dialog)
    dialog.showModal()
  }

  private async renderAudit(nonce: number): Promise<void> {
    const response = await api<{ items: AuditItem[] }>('/v1/admin/audit?limit=150')
    if (nonce !== this.renderNonce) return
    const fragment = document.createDocumentFragment()
    fragment.append(this.pageHeader('Administrative history', 'Audit', 'Authenticated control-plane changes. Tokens and message bodies are never recorded.'))
    if (response.items.length === 0) fragment.append(emptyState('No audit entries', 'Control-plane changes will appear here.'))
    else {
      const timeline = element('section', 'timeline')
      for (const item of response.items) {
        const event = element('article', 'timeline__item')
        const copy = element('div')
        copy.append(element('strong', undefined, item.action.replace(/_/g, ' ')), element('span', 'mono', `${item.target_type} · ${item.target_id}`))
        const meta = element('div', 'timeline__meta')
        meta.append(element('span', undefined, item.actor), element('time', undefined, formatDate(item.occurred_at)))
        event.append(copy, meta)
        timeline.append(event)
      }
      fragment.append(timeline)
    }
    this.content.replaceChildren(fragment)
  }

  private loading(label: string): HTMLElement {
    const node = element('div', 'loading')
    node.append(element('span', 'loading__mark', 'V'), element('span', undefined, label))
    return node
  }

  private failure(message: string, error: unknown): HTMLElement {
    const node = element('section', 'failure')
    node.append(element('span', 'eyebrow', 'Safe failure'), element('h2', undefined, message), element('p', undefined, this.errorMessage(error)))
    const retry = button('Retry', 'primary')
    retry.addEventListener('click', () => void this.navigate(this.activePage))
    node.append(retry)
    return node
  }

  private toast(message: string, danger = false): void {
    const node = element('div', `toast${danger ? ' toast--danger' : ''}`, message)
    this.toastRegion.append(node)
    window.setTimeout(() => node.remove(), 5_000)
  }

  private errorMessage(error: unknown): string {
    if (error instanceof ApiError) {
      const messages: Record<string, string> = {
        conflict: 'This record changed or the operation conflicts with current state. Refresh and try again.',
        forbidden: 'The request was rejected by the Control Panel security policy.',
        invalid_request: 'The submitted values were rejected. Check formats, dates and text limits.',
        payload_too_large: 'The submitted payload is too large.',
        precondition_required: 'Refresh this record before editing it.',
        rate_limited: 'Too many requests. Wait a minute and try again.',
        unauthorized: 'Your Cloudflare Access session is missing or expired.',
        unsupported_media_type: 'The selected file type is not allowed.'
      }
      return messages[error.code] ?? 'The operation failed safely. No partial publication was performed.'
    }
    return 'The service is temporarily unavailable. Existing Relay delivery remains independent.'
  }

  private bytes(value: number): string {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${(value / (1024 * 1024)).toFixed(2)} MiB`
  }
}

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('Control Panel root is missing.')
void new ControlPanel(root).start()
