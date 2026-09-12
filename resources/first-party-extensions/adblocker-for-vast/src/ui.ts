declare const chrome: any
const $ = (id: string) => document.getElementById(id) as any
let current: any, baseline: any, dirty = false, busy = false
const options = document.body.dataset.page === 'options'
async function call(input: any) { const response = await chrome.runtime.sendMessage(input); if (!response?.ok) throw new Error(response?.error || 'Extension is unavailable.'); return response.value }
function error(value: unknown) { $('error').textContent = value instanceof Error ? value.message : String(value ?? '') }
async function action(input: any, replace = false) {
  if (busy) return
  busy = true; error('')
  try { await call(input); if (replace) dirty = false; await refresh(replace) } catch (failure) { error(failure) } finally { busy = false }
}
function toggle(id: string, value: boolean) { $(id).checked = value }
function renderLists() {
  const container = $('lists'); container.replaceChildren()
  for (const list of current.lists) {
    const row = document.createElement('label'); row.className = 'row'
    const body = document.createElement('span'), name = document.createElement('strong'), meta = document.createElement('small'), warn = document.createElement('small'), control = document.createElement('input')
    name.textContent = list.name; meta.textContent = list.checkedAt ? `Checked ${new Date(list.checkedAt).toLocaleString()}${list.rules ? ` · ${list.rules.toLocaleString()} rules` : ''}` : 'Bundled copy'
    warn.className = 'warning'; warn.textContent = list.error || (list.unsupported ? `${list.unsupported} unsupported rules; see compatibility below.` : '')
    control.type = 'checkbox'; control.dataset.list = list.id; control.checked = current.settings.lists.includes(list.id); control.addEventListener('change', () => dirty = true)
    body.append(name, meta, warn); row.append(body, control); container.append(row)
  }
}
function renderSites() {
  const container = $('sites'); container.replaceChildren(); const search = $('search').value.toLowerCase()
  for (const host of ($('allowlist').value as string).split('\n').filter(Boolean).filter(host => host.includes(search))) {
    const row = document.createElement('div'); row.className = 'row'; const label = document.createElement('span'), button = document.createElement('button'); label.textContent = host; button.textContent = 'Remove'; button.addEventListener('click', () => { $('allowlist').value = $('allowlist').value.split('\n').filter((value: string) => value !== host).join('\n'); dirty = true; renderSites() }); row.append(label, button); container.append(row)
  }
}
async function refresh(replace = false) {
  try {
    current = await call({ type: 'status' }); $('state').textContent = current.error || (!current.ready ? 'Loading filters…' : !current.settings.enabled ? 'Blocking disabled' : current.hostname && !current.siteEnabled ? 'Disabled on this site' : 'Blocking enabled')
    if (options) {
      $('update').textContent = current.updating ? 'Updating…' : 'Update now'; $('update').disabled = busy || current.updating
      if (replace || !baseline || !dirty) { baseline = structuredClone(current.settings); for (const key of ['enabled', 'blockAds', 'blockTrackers', 'cosmetics', 'autoUpdate']) toggle(key, current.settings[key]); $('custom').value = current.settings.customFilters; $('allowlist').value = current.settings.allowlist.join('\n'); renderLists(); renderSites() }
    } else {
      $('hostname').textContent = current.hostname || 'Open a website'; $('page-count').textContent = current.pageBlocked.toLocaleString(); $('total-count').textContent = current.totalBlocked.toLocaleString()
      toggle('enabled', current.settings.enabled); toggle('site', current.siteEnabled); toggle('cosmetics', current.cosmeticActive)
      $('site').disabled = !current.hostname || !current.ready; $('cosmetics').disabled = !current.siteEnabled; $('pick').disabled = !current.siteEnabled; $('reload').disabled = !current.hostname
    }
  } catch (failure) { error(failure) }
}
if (options) {
  document.querySelectorAll('input,textarea').forEach(element => element.addEventListener('input', () => dirty = true))
  $('save').onclick = () => { const next = { ...baseline }; for (const key of ['enabled', 'blockAds', 'blockTrackers', 'cosmetics', 'autoUpdate']) next[key] = $(key).checked; next.lists = [...document.querySelectorAll<HTMLInputElement>('[data-list]:checked')].map(input => input.dataset.list); next.allowlist = $('allowlist').value.split('\n').map((host: string) => host.trim()).filter(Boolean); next.customFilters = $('custom').value; void action({ type: 'settings', settings: next, expected: baseline }, true) }
  $('load').onclick = () => { dirty = false; void refresh(true) }
  $('update').onclick = () => void action({ type: 'update' })
  $('reset').onclick = () => void action({ type: 'reset-stats' })
  $('add-site').onclick = () => { const host = $('new-site').value.trim(); if (host) { $('allowlist').value += ($('allowlist').value ? '\n' : '') + host; $('new-site').value = ''; dirty = true; renderSites() } }
  $('search').oninput = renderSites
  $('clear').onclick = () => { $('custom').value = ''; dirty = true }
  $('import').onchange = async () => { const file = $('import').files?.[0]; if (!file) return; if (file.size > 65536) { error('Custom filters exceed 64 KiB.'); return } $('custom').value = await file.text(); dirty = true }
  $('export').onclick = () => { const url = URL.createObjectURL(new Blob([$('custom').value], { type: 'text/plain' })), link = document.createElement('a'); link.href = url; link.download = 'adblocker-for-vast-filters.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
} else {
  $('enabled').onchange = () => void action({ type: 'settings', settings: { ...current.settings, enabled: $('enabled').checked }, expected: current.settings })
  $('site').onchange = () => void action({ type: 'site', tabId: current.tabId, url: current.url, enabled: $('site').checked })
  $('cosmetics').onchange = () => void action({ type: 'site', tabId: current.tabId, url: current.url, enabled: $('cosmetics').checked, cosmeticOnly: true })
  $('reload').onclick = () => void action({ type: 'reload', tabId: current.tabId, url: current.url })
  $('pick').onclick = async () => { try { await call({ type: 'picker', tabId: current.tabId, url: current.url }); window.close() } catch (failure) { error(failure) } }
  $('settings').onclick = () => { location.href = chrome.runtime.getURL('options.html') }
}
void refresh(true); setInterval(() => { if (!busy) void refresh() }, 1500)
