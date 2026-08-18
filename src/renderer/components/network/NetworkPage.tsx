import {
  Activity,
  Cast,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  Heart,
  Info,
  Monitor,
  Printer,
  RefreshCw,
  Router,
  Search,
  Server,
  Shield,
  Star,
  Trash2,
  Tv,
  Volume2,
  Wifi
} from 'lucide-react'
import type { ReactNode } from 'react'
import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { NetworkDevice, NetworkDeviceCategory, NetworkDeviceSource } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatRelativeTime } from '../../lib/format'
import { useBrowserStore } from '../../store/browser-store'
import { InternalLoadingSkeleton } from '../internal/InternalPage'
import { useVastConfirm } from '../ui/useVastConfirm'

const categories: Array<NetworkDeviceCategory | 'all'> = ['all', 'cast', 'audio', 'tv', 'router', 'printer', 'nas', 'smart-home', 'computer', 'unknown']
const sources: Array<NetworkDeviceSource | 'all'> = ['all', 'mdns', 'ssdp', 'probe', 'arp', 'mock']

function categoryLabel(category: NetworkDeviceCategory): string {
  return {
    audio: 'Audio',
    tv: 'TV',
    cast: 'Chromecast',
    computer: 'Computer',
    phone: 'Phone',
    printer: 'Printer',
    router: 'Router',
    nas: 'NAS',
    'smart-home': 'Smart home',
    unknown: 'Unknown'
  }[category]
}

function CategoryIcon({ category, className = 'h-4 w-4' }: { category: NetworkDeviceCategory; className?: string }): JSX.Element {
  if (category === 'cast') return <Cast className={className} />
  if (category === 'audio') return <Volume2 className={className} />
  if (category === 'tv') return <Tv className={className} />
  if (category === 'router') return <Router className={className} />
  if (category === 'printer') return <Printer className={className} />
  if (category === 'nas') return <Server className={className} />
  if (category === 'smart-home') return <Shield className={className} />
  if (category === 'computer') return <Monitor className={className} />
  return <Wifi className={className} />
}

function deviceBadges(device: NetworkDevice): string[] {
  const haystack = `${device.deviceType ?? ''} ${device.services.map((service) => service.type).join(' ')}`.toLowerCase()
  const badges = new Set<string>()
  if (device.category === 'cast' || haystack.includes('googlecast')) badges.add('Chromecast')
  if (haystack.includes('airplay') || haystack.includes('raop')) badges.add('AirPlay')
  if (haystack.includes('mediarenderer') || haystack.includes('upnp')) badges.add('DLNA/UPnP')
  if (device.category === 'router') badges.add('Router')
  if (device.webUrls.length > 0 || device.presentationUrl) badges.add('Web UI')
  if (device.category === 'audio') badges.add('Audio')
  if (badges.size === 0) badges.add(categoryLabel(device.category))
  return [...badges].slice(0, 4)
}

function visibleName(device: NetworkDevice): string {
  return device.alias?.trim() || device.name
}

function identificationConfidence(device: NetworkDevice): 'High' | 'Medium' | 'Low' {
  if (device.sources.length >= 2 && Boolean(device.manufacturer || device.model || device.services.length)) return 'High'
  if (device.sources.length >= 2 || Boolean(device.manufacturer || device.model || device.services.length)) return 'Medium'
  return 'Low'
}

export function NetworkPage(): JSX.Element {
  const confirm = useVastConfirm()
  const runtime = useBrowserRuntime()
  const networkSettings = useBrowserStore((state) => state.settings.network)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const [devices, setDevices] = useState<NetworkDevice[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<NetworkDeviceCategory | 'all'>('all')
  const [source, setSource] = useState<NetworkDeviceSource | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [lastScanAt, setLastScanAt] = useState<number | undefined>(undefined)
  const deferredQuery = useDeferredValue(query)
  const selected = devices.find((device) => device.id === selectedId) ?? devices[0]

  const applyInventoryResult = (
    result:
      | Awaited<ReturnType<typeof window.vast.network.getDevices>>
      | Awaited<ReturnType<typeof window.vast.network.scan>>
  ): void => {
    startTransition(() => {
      if (result.ok) {
        const nextDevices = result.devices ?? []
        setDevices(nextDevices)
        setLogs(result.logs ?? [])
        if (typeof result.finishedAt === 'number') setLastScanAt(result.finishedAt)
        setScanning('scanning' in result ? Boolean(result.scanning) : false)
        setError(null)
        setSelectedId((current) => (current && nextDevices.some((device) => device.id === current) ? current : nextDevices[0]?.id ?? null))
      } else {
        setError(result.error ?? 'Could not load network devices.')
      }
      setLoading(false)
    })
  }

  const refresh = async (): Promise<void> => {
    setLoading(true)
    applyInventoryResult(await window.vast.network.getDevices())
  }

  useEffect(() => {
    void refresh()
  }, [])

  const scan = async (): Promise<void> => {
    if (!networkSettings.enabled) {
      setError('Network Devices is disabled in Settings.')
      return
    }
    let confirmed = networkSettings.allowScans
    if (!confirmed) {
      confirmed = await confirm('Scan the local network?', 'Vast will look for nearby devices. Discovery data stays on this device.', 'Start scan')
      if (!confirmed) return
      updateSettings({ network: { allowScans: true } })
    }
    setScanning(true)
    setError(null)
    const result = await window.vast.network.scan({
      mdns: networkSettings.passiveDiscovery,
      ssdp: networkSettings.passiveDiscovery,
      arp: true,
      probe: networkSettings.activeProbing,
      confirmed
    })
    if (result.ok) {
      applyInventoryResult(result)
    } else {
      startTransition(() => {
        setScanning(false)
        setError(result.error ?? 'Network scan failed.')
      })
    }
  }

  const filtered = useMemo(() => {
    const needle = deferredQuery.toLowerCase().trim()
    return devices.filter((device) => {
      const matchesCategory = category === 'all' || device.category === category
      const matchesSource = source === 'all' || device.sources.includes(source)
      const text = `${visibleName(device)} ${device.hostname ?? ''} ${device.primaryIp ?? ''} ${device.manufacturer ?? ''} ${device.model ?? ''} ${device.deviceType ?? ''}`.toLowerCase()
      return matchesCategory && matchesSource && (!needle || text.includes(needle))
    })
  }, [category, deferredQuery, devices, source])

  const summary = useMemo(
    () => ({
      total: devices.length,
      castAudio: devices.filter((device) => device.category === 'cast' || device.category === 'audio').length,
      webPanels: devices.filter((device) => device.webUrls.length > 0 || device.presentationUrl).length,
      online: devices.filter((device) => device.online).length
    }),
    [devices]
  )

  const updateDevice = async (id: string, patch: Partial<Pick<NetworkDevice, 'alias' | 'favorite' | 'pinned' | 'notes'>>): Promise<void> => {
    const result = await window.vast.network.updateDevice(id, patch)
    if (!result.ok || !result.device) {
      setError(result.error ?? 'Could not update device.')
      return
    }
    startTransition(() => {
      setDevices((items) => items.map((device) => (device.id === id ? result.device as NetworkDevice : device)))
    })
  }

  const forgetDevice = async (id: string): Promise<void> => {
    if (!await confirm('Forget this device?', 'The device will be removed from Vast local cache.', 'Forget device')) return
    const result = await window.vast.network.forgetDevice(id)
    if (result.ok) {
      startTransition(() => {
        setDevices((items) => items.filter((device) => device.id !== id))
        if (selectedId === id) setSelectedId(null)
      })
    } else {
      setError(result.error ?? 'Could not forget device.')
    }
  }

  const openWebPanel = async (device: NetworkDevice): Promise<void> => {
    const url = device.presentationUrl || device.webUrls[0]
    if (!url) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported device panel protocol.')
      const approved = await confirm(
        `Open panel for ${visibleName(device)}?`,
        `${parsed.origin}. Local device panels may be unencrypted or controlled by the device vendor. Vast will open it as a normal tab with standard site isolation.`,
        'Open device panel'
      )
      if (approved) runtime.openUrlInNewTab(parsed.href)
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Invalid device panel URL.')
    }
  }

  return (
    <div className="labs-page-surface h-full overflow-y-auto overflow-x-hidden bg-[#06070a] p-5 text-white lg:p-6" data-testid="network-page">
      <div className="mx-auto grid max-w-[1480px] gap-5 xl:grid-cols-[minmax(0,1fr)_410px]">
        <section className="space-y-5">
          <header className="vast-glass-panel rounded-[32px] p-6">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div>
                <h1 className="text-4xl font-semibold tracking-tight">Local network map</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-vast-soft">
                  Vast scans only your local network and does not send device data anywhere. Scans run only when you trigger them.
                </p>
                <div className="mt-3 text-xs text-vast-soft">Last scan: {lastScanAt ? formatRelativeTime(lastScanAt) : 'Never'} · Sources: ARP table, mDNS and SSDP; active port probes are separately disabled by default.</div>
              </div>
              <div className="grid w-full grid-cols-2 gap-2 sm:w-auto lg:w-52 lg:grid-cols-1" data-testid="network-primary-actions">
                <button type="button" onClick={() => void refresh()} className="vault-action-button justify-center" disabled={loading || scanning}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </button>
                <button type="button" onClick={() => void scan()} className="vault-action-button justify-center bg-vast-cyan text-black" disabled={scanning} data-testid="network-scan-button">
                  <Activity className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
                  {scanning ? 'Scanning...' : 'Scan local network'}
                </button>
              </div>
            </div>
            {error && <div className="mt-4 rounded-2xl border border-vast-amber/25 bg-vast-amber/10 p-3 text-sm text-vast-amber">{error}</div>}
            {!networkSettings.enabled && (
              <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-vast-amber/25 bg-vast-amber/[0.08] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div><div className="text-sm font-semibold">Local discovery is off</div><div className="mt-1 text-xs leading-5 text-vast-soft">Enabling it does not scan automatically. Windows Firewall may ask about local-network access when you start the first scan.</div></div>
                <button type="button" onClick={() => updateSettings({ network: { enabled: true, allowScans: false } })} className="vault-action-button shrink-0">Enable discovery</button>
              </div>
            )}
          </header>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={Wifi} label="Devices found" value={summary.total} />
            <SummaryCard icon={Cast} label="Audio / cast" value={summary.castAudio} />
            <SummaryCard icon={Globe2} label="Web panels" value={summary.webPanels} />
            <SummaryCard icon={Shield} label="Online now" value={summary.online} />
          </div>

          <section className="vast-glass-panel rounded-[28px] p-4">
            <div className="grid gap-3">
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search devices, IPs, models, services"
                  className="h-11 w-full rounded-2xl border border-transparent bg-white/[0.035] pl-10 pr-3 text-sm text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)] outline-none transition focus:shadow-[inset_0_0_0_1px_rgba(116,231,255,0.32),0_0_28px_rgba(116,231,255,0.07)]"
                />
              </div>
              <div className="grid gap-2 border-t border-white/[0.06] pt-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
                <div className="pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-vast-soft">Category</div>
                <div className="flex flex-wrap gap-2">
                  {categories.map((item) => (
                    <FilterButton key={item} active={category === item} onClick={() => setCategory(item)}>
                      {item === 'all' ? 'All' : categoryLabel(item)}
                    </FilterButton>
                  ))}
                </div>
              </div>
              <div className="grid gap-2 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
                <div className="pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-vast-soft">Source</div>
                <div className="flex flex-wrap gap-2">
                  {sources.map((item) => (
                    <FilterButton key={item} active={source === item} onClick={() => setSource(item)}>
                      {item === 'all' ? 'All sources' : item.toUpperCase()}
                    </FilterButton>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-3 lg:grid-cols-2">
            {loading && devices.length === 0 ? (
              <>
                <InternalLoadingSkeleton title="Scanning network inventory" lines={5} className="min-h-[220px]" />
                <InternalLoadingSkeleton title="Resolving local devices" lines={5} className="min-h-[220px]" />
              </>
            ) : (
              filtered.map((device) => (
              <button
                type="button"
                key={device.id}
                onClick={() => setSelectedId(device.id)}
                className={`vast-glass-panel rounded-[26px] p-4 text-left transition duration-150 hover:-translate-y-0.5 ${selected?.id === device.id ? 'shadow-[0_0_34px_rgba(116,231,255,0.08),inset_0_0_0_1px_rgba(116,231,255,0.24)]' : ''}`}
              >
                <div className="flex items-start gap-4">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.06] text-vast-cyan">
                    <CategoryIcon category={device.category} className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold">{visibleName(device)}</div>
                        <div className="mt-1 truncate text-xs text-vast-soft">{device.manufacturer || device.model ? `${device.manufacturer ?? ''} ${device.model ?? ''}`.trim() : device.hostname || device.primaryIp || 'Local device'}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        {device.favorite && <Star className="h-4 w-4 fill-vast-cyan text-vast-cyan" />}
                        <span className={`h-2.5 w-2.5 rounded-full ${device.online ? 'bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,0.55)]' : 'bg-white/25'}`} />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {deviceBadges(device).map((badge) => (
                        <span key={badge} className="rounded-full border border-white/[0.08] bg-white/[0.045] px-2 py-1 text-[11px] text-vast-soft">
                          {badge}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-vast-soft sm:grid-cols-2">
                      <div className="truncate">IP: {device.primaryIp ?? 'unknown'}</div>
                      <div className="truncate">Source: {device.sources.join(', ')}</div>
                      <div className="truncate">Ports: {device.ports.length ? device.ports.join(', ') : 'none'}</div>
                      <div className="truncate">Last seen: {formatRelativeTime(device.lastSeenAt)}</div>
                      <div className="truncate">Identification: {identificationConfidence(device)} confidence</div>
                    </div>
                  </div>
                </div>
              </button>
              ))
            )}
            {!loading && filtered.length === 0 && (
              <div className="vast-glass-panel col-span-full rounded-[28px] p-10 text-center">
                <Wifi className="mx-auto h-8 w-8 text-vast-cyan" />
                <div className="mt-4 text-lg font-semibold">No devices yet</div>
                <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-vast-soft">
                  Run a manual scan to discover mDNS, SSDP/UPnP, ARP neighbors, and optional web panels on your local subnet.
                </div>
              </div>
            )}
          </section>
        </section>

        <aside className="vast-glass-panel sticky top-6 min-w-0 max-h-[calc(100vh-3rem)] overflow-y-auto rounded-[30px] p-5">
          {loading && devices.length === 0 ? (
            <InternalLoadingSkeleton title="Preparing device detail" lines={6} className="min-h-[320px]" />
          ) : selected ? (
            <div className="space-y-5" data-testid="network-device-detail">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-vast-cyan">
                    <CategoryIcon category={selected.category} />
                    {categoryLabel(selected.category)}
                  </div>
                  <h2 className="mt-2 break-words text-2xl font-semibold leading-tight">{visibleName(selected)}</h2>
                  <p className="mt-1 truncate text-xs text-vast-soft">{selected.deviceType ?? 'Local network device'}</p>
                </div>
                <button
                  type="button"
                  title="Favorite device"
                  onClick={() => void updateDevice(selected.id, { favorite: !selected.favorite })}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/[0.045] text-vast-cyan shadow-[inset_0_0_0_1px_rgba(255,255,255,0.065)] transition hover:bg-white/[0.08] hover:shadow-[inset_0_0_0_1px_rgba(116,231,255,0.24),0_0_24px_rgba(116,231,255,0.08)]"
                >
                  <Heart className={`h-4 w-4 ${selected.favorite ? 'fill-current' : ''}`} />
                </button>
              </div>

              <label className="grid gap-2 text-sm font-semibold">
                Alias
                <input
                  defaultValue={selected.alias ?? ''}
                  onBlur={(event) => void updateDevice(selected.id, { alias: event.target.value })}
                  placeholder={selected.name}
                  className="rounded-2xl border border-transparent bg-white/[0.035] px-3 py-2 text-sm text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)] outline-none transition focus:shadow-[inset_0_0_0_1px_rgba(116,231,255,0.3),0_0_24px_rgba(116,231,255,0.07)]"
                />
              </label>

              <div className="grid gap-2 text-sm">
                <InfoRow label="IP" value={selected.primaryIp ?? 'unknown'} copyValue={selected.primaryIp} />
                <InfoRow label="Hostname" value={selected.hostname ?? 'unknown'} copyValue={selected.hostname} />
                <InfoRow label="MAC" value={selected.macAddress ?? 'unknown'} copyValue={selected.macAddress} />
                <InfoRow label="Maker" value={`${selected.manufacturer ?? ''} ${selected.model ?? ''}`.trim() || 'unknown'} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button type="button" disabled={!selected.webUrls.length && !selected.presentationUrl} onClick={() => void openWebPanel(selected)} className="vault-action-button justify-center disabled:opacity-40">
                  <ExternalLink className="h-4 w-4" />
                  Open panel
                </button>
                <button type="button" onClick={() => selected.primaryIp && void navigator.clipboard.writeText(selected.primaryIp)} className="vault-action-button justify-center">
                  <Copy className="h-4 w-4" />
                  Copy IP
                </button>
              </div>

              <label className="grid gap-2 text-sm font-semibold">
                Notes
                <textarea
                  defaultValue={selected.notes ?? ''}
                  onBlur={(event) => void updateDevice(selected.id, { notes: event.target.value })}
                  placeholder="Local notes about this device"
                  rows={4}
                  className="resize-none rounded-2xl border border-transparent bg-white/[0.032] p-3 text-sm leading-6 text-vast-soft shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)] outline-none transition focus:shadow-[inset_0_0_0_1px_rgba(116,231,255,0.3),0_0_24px_rgba(116,231,255,0.07)]"
                />
              </label>

              <div>
                <div className="mb-2 text-sm font-semibold">Services</div>
                <div className="space-y-2">
                  {selected.services.slice(0, 8).map((service, index) => (
                    <div key={`${service.type}-${index}`} className="rounded-2xl bg-white/[0.032] p-3 text-xs text-vast-soft shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
                      <div className="font-semibold text-white">{service.name}</div>
                      <div className="mt-1 truncate">{service.type}</div>
                      {service.port && <div className="mt-1">Port {service.port}</div>}
                    </div>
                  ))}
                  {selected.services.length === 0 && <div className="rounded-2xl bg-white/[0.032] p-3 text-xs text-vast-soft shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">No service metadata yet.</div>}
                </div>
              </div>

              <button type="button" onClick={() => void forgetDevice(selected.id)} className="vault-danger-button w-full justify-center">
                <Trash2 className="h-4 w-4" />
                Forget device
              </button>
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-vast-soft">
              <Wifi className="mx-auto mb-3 h-7 w-7 text-vast-cyan" />
              Select a device to inspect metadata, services, and local notes.
            </div>
          )}
        </aside>

        <section className="vast-glass-panel rounded-[28px] p-5 xl:col-span-2">
          <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex w-full items-center justify-between text-left">
            <span>
              <span className="block text-sm font-semibold">Advanced scan log</span>
              <span className="mt-1 block text-xs text-vast-soft">Raw source hints stay local and are useful for debugging mDNS, SSDP, probes, and ARP.</span>
            </span>
            <Info className="h-4 w-4 text-vast-cyan" />
          </button>
          {showAdvanced && (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
              <div className="max-h-72 overflow-y-auto rounded-2xl bg-white/[0.032] p-3 font-mono text-xs leading-6 text-vast-soft shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
                {logs.length ? logs.map((log) => <div key={log}>{log}</div>) : 'No scan log yet.'}
              </div>
              <div className="space-y-2">
                <button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ devices, logs }, null, 2))} className="settings-action settings-action-compact w-full justify-center">
                  <Copy className="h-4 w-4" />
                  Copy diagnostics
                </button>
                <button type="button" onClick={() => void window.vast.network.exportInventory()} className="settings-action settings-action-compact w-full justify-center">
                  <Download className="h-4 w-4" />
                  Export inventory
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!await confirm('Clear network cache?', 'Remembered devices and aliases will be removed.', 'Clear cache')) return
                    await window.vast.network.clearCache()
                    setDevices([])
                    setLogs([])
                  }}
                  className="vault-danger-button w-full justify-center"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear network cache
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value }: { icon: typeof Wifi; label: string; value: number }): JSX.Element {
  return (
    <div className="vast-glass-panel min-h-[104px] rounded-[24px] p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-vast-soft">{label}</span>
        <Icon className="h-4 w-4 text-vast-cyan" />
      </div>
      <div className="mt-3 text-3xl font-semibold">{value}</div>
    </div>
  )
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? 'border-transparent bg-vast-cyan/[0.12] text-vast-cyan shadow-[0_0_0_1px_rgba(116,231,255,0.28),0_0_20px_rgba(116,231,255,0.08)]'
          : 'border-transparent bg-white/[0.035] text-vast-soft shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-white/[0.07] hover:text-white hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
      }`}
    >
      {children}
    </button>
  )
}

function InfoRow({ label, value, copyValue }: { label: string; value: string; copyValue?: string }): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-white/[0.032] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]">
      <span className="min-w-0 truncate text-xs font-medium text-vast-soft">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-2 text-right text-sm font-semibold">
        <span className="min-w-0 truncate" title={value}>{value}</span>
        {copyValue && (
          <button type="button" onClick={() => void navigator.clipboard.writeText(copyValue)} className="shrink-0 text-vast-cyan transition hover:text-white" title={`Copy ${label}`}>
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </div>
  )
}
