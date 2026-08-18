import { dialog, type BrowserWindow } from 'electron/main'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import type {
  BrowserSettings,
  NetworkDevice,
  NetworkDeviceCategory,
  NetworkDevicePatch,
  NetworkDeviceService,
  NetworkDeviceSource,
  NetworkScanOptions,
  NetworkScanResult
} from './types'
import { dataFilePath } from '../data-path'
import { atomicWriteJson } from '../atomic-file'
import { fetchPrivateNetworkText, isPrivateNetworkIp, safeHttpUrl } from './safe-http'

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353
const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const PROBE_PORTS = [80, 443, 8008, 8009, 8080, 8443, 5000, 5001, 8123, 7000, 49152]
const MDNS_SERVICES = [
  '_googlecast._tcp.local',
  '_airplay._tcp.local',
  '_raop._tcp.local',
  '_spotify-connect._tcp.local',
  '_http._tcp.local',
  '_https._tcp.local',
  '_printer._tcp.local',
  '_ipp._tcp.local',
  '_smb._tcp.local',
  '_home-assistant._tcp.local'
]

interface NetworkDeviceStore {
  devices: NetworkDevice[]
  known: Record<string, Pick<NetworkDevice, 'alias' | 'favorite' | 'pinned' | 'notes' | 'firstSeenAt'>>
  logs: string[]
  lastScanAt?: number
}

let cache: NetworkDeviceStore | null = null
let activeScan: Promise<NetworkScanResult> | null = null

function storePath(): string {
  return dataFilePath('vast-network-devices.json')
}

function hashId(input: string): string {
  return `net-${createHash('sha1').update(input).digest('hex').slice(0, 16)}`
}

function nowDevice(partial: Partial<NetworkDevice> & Pick<NetworkDevice, 'name' | 'category'>): NetworkDevice {
  const now = Date.now()
  const source = partial.source ?? 'manual'
  const primaryIp = partial.primaryIp ?? partial.addresses?.[0]
  const id = partial.id ?? hashId(`${partial.macAddress ?? ''}|${primaryIp ?? ''}|${partial.hostname ?? ''}|${partial.name}|${partial.deviceType ?? ''}`)
  return {
    id,
    source,
    sources: partial.sources ?? [source],
    name: partial.name,
    alias: partial.alias,
    hostname: partial.hostname,
    addresses: unique(partial.addresses ?? (primaryIp ? [primaryIp] : [])),
    primaryIp,
    macAddress: partial.macAddress,
    manufacturer: partial.manufacturer,
    model: partial.model,
    deviceType: partial.deviceType,
    category: partial.category,
    services: partial.services ?? [],
    ports: uniqueNumbers(partial.ports ?? []),
    webUrls: unique(partial.webUrls ?? []),
    presentationUrl: partial.presentationUrl,
    iconUrl: partial.iconUrl,
    firstSeenAt: partial.firstSeenAt ?? now,
    lastSeenAt: partial.lastSeenAt ?? now,
    online: partial.online ?? true,
    favorite: partial.favorite,
    pinned: partial.pinned,
    notes: partial.notes,
    raw: partial.raw
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => Number.isFinite(value)))].sort((a, b) => a - b)
}

const isPrivateIp = isPrivateNetworkIp

function categoryFor(serviceOrType = '', manufacturer = '', model = ''): NetworkDeviceCategory {
  const haystack = `${serviceOrType} ${manufacturer} ${model}`.toLowerCase()
  if (haystack.includes('googlecast') || haystack.includes('chromecast') || haystack.includes('cast')) return 'cast'
  if (haystack.includes('airplay') || haystack.includes('raop') || haystack.includes('spotify')) return 'audio'
  if (haystack.includes('mediarenderer') || haystack.includes('tv') || haystack.includes('roku')) return 'tv'
  if (haystack.includes('printer') || haystack.includes('ipp')) return 'printer'
  if (haystack.includes('internetgatewaydevice') || haystack.includes('router') || haystack.includes('gateway')) return 'router'
  if (haystack.includes('smb') || haystack.includes('nas')) return 'nas'
  if (haystack.includes('home-assistant') || haystack.includes('hass')) return 'smart-home'
  return 'unknown'
}

function mergeDevice(a: NetworkDevice, b: NetworkDevice): NetworkDevice {
  const category = a.category !== 'unknown' ? a.category : b.category
  return {
    ...a,
    name: a.alias || a.name !== 'Unknown device' ? a.name : b.name,
    hostname: a.hostname ?? b.hostname,
    addresses: unique([...a.addresses, ...b.addresses]),
    primaryIp: a.primaryIp ?? b.primaryIp,
    macAddress: a.macAddress ?? b.macAddress,
    manufacturer: a.manufacturer ?? b.manufacturer,
    model: a.model ?? b.model,
    deviceType: a.deviceType ?? b.deviceType,
    category,
    services: [...a.services, ...b.services].filter((service, index, list) => index === list.findIndex((item) => item.type === service.type && item.port === service.port && item.name === service.name)),
    ports: uniqueNumbers([...a.ports, ...b.ports]),
    webUrls: unique([...a.webUrls, ...b.webUrls]),
    presentationUrl: a.presentationUrl ?? b.presentationUrl,
    iconUrl: a.iconUrl ?? b.iconUrl,
    sources: unique([...a.sources, ...b.sources]) as NetworkDeviceSource[],
    source: a.source,
    firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
    lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
    online: a.online || b.online,
    raw: { ...(a.raw ?? {}), ...(b.raw ?? {}) }
  }
}

function mergeDevices(devices: NetworkDevice[]): NetworkDevice[] {
  const merged: NetworkDevice[] = []
  for (const device of devices) {
    const matchIndex = merged.findIndex((item) => {
      if (item.id === device.id) return true
      if (item.macAddress && device.macAddress && item.macAddress === device.macAddress) return true
      if (item.primaryIp && device.primaryIp && item.primaryIp === device.primaryIp) return true
      return false
    })
    if (matchIndex >= 0) merged[matchIndex] = mergeDevice(merged[matchIndex], device)
    else merged.push(device)
  }
  return merged.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.lastSeenAt - a.lastSeenAt)
}

async function loadStore(): Promise<NetworkDeviceStore> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<NetworkDeviceStore>
    cache = {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      known: parsed.known && typeof parsed.known === 'object' ? parsed.known : {},
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-200) : [],
      lastScanAt: parsed.lastScanAt
    }
  } catch {
    cache = { devices: [], known: {}, logs: [] }
  }
  return cache
}

async function saveStore(store: NetworkDeviceStore): Promise<void> {
  const file = storePath()
  await atomicWriteJson(file, store)
  cache = store
}

function applyKnown(device: NetworkDevice, store: NetworkDeviceStore): NetworkDevice {
  const known = store.known[device.id]
  if (!known) return device
  return {
    ...device,
    alias: known.alias,
    favorite: known.favorite,
    pinned: known.pinned,
    notes: known.notes,
    firstSeenAt: known.firstSeenAt ?? device.firstSeenAt
  }
}

function appendLog(logs: string[], message: string): void {
  logs.push(`${new Date().toLocaleTimeString()} ${message}`)
}

function writeDnsName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.')
  return Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])])
}

function buildMdnsQuery(): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(Math.floor(Math.random() * 65535), 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt16BE(MDNS_SERVICES.length, 4)
  const questions = MDNS_SERVICES.map((service) => Buffer.concat([writeDnsName(service), Buffer.from([0, 12, 0, 1])]))
  return Buffer.concat([header, ...questions])
}

function readName(buffer: Buffer, offset: number, depth = 0): { name: string; offset: number } {
  if (depth > 8) return { name: '', offset }
  const labels: string[] = []
  let cursor = offset
  let jumped = false
  let nextOffset = offset
  while (cursor < buffer.length) {
    const length = buffer[cursor]
    if (length === 0) {
      cursor += 1
      if (!jumped) nextOffset = cursor
      break
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1]
      const pointed = readName(buffer, pointer, depth + 1)
      if (pointed.name) labels.push(pointed.name)
      cursor += 2
      if (!jumped) nextOffset = cursor
      jumped = true
      break
    }
    cursor += 1
    labels.push(buffer.subarray(cursor, cursor + length).toString('utf8'))
    cursor += length
    if (!jumped) nextOffset = cursor
  }
  return { name: labels.join('.'), offset: nextOffset }
}

function parseTxt(buffer: Buffer): Record<string, string> {
  const txt: Record<string, string> = {}
  let offset = 0
  while (offset < buffer.length) {
    const length = buffer[offset]
    offset += 1
    const raw = buffer.subarray(offset, offset + length).toString('utf8')
    offset += length
    const eq = raw.indexOf('=')
    if (eq > 0) txt[raw.slice(0, eq)] = raw.slice(eq + 1)
    else if (raw) txt[raw] = 'true'
  }
  return txt
}

function serviceFromInstance(instance: string): string | undefined {
  const lower = instance.toLowerCase()
  return MDNS_SERVICES.find((service) => lower.endsWith(`.${service}`)) ?? MDNS_SERVICES.find((service) => lower === service)
}

function parseMdnsPacket(buffer: Buffer, remoteAddress: string): NetworkDevice[] {
  const records: Array<{ name: string; type: number; data: Buffer; target?: string; port?: number; txt?: Record<string, string> }> = []
  let offset = 12
  const qd = buffer.readUInt16BE(4)
  const total = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10)
  for (let i = 0; i < qd; i += 1) {
    const name = readName(buffer, offset)
    offset = name.offset + 4
  }
  for (let i = 0; i < total && offset < buffer.length; i += 1) {
    const name = readName(buffer, offset)
    offset = name.offset
    if (offset + 10 > buffer.length) break
    const type = buffer.readUInt16BE(offset)
    offset += 8
    const length = buffer.readUInt16BE(offset)
    offset += 2
    const dataOffset = offset
    const data = buffer.subarray(offset, offset + length)
    offset += length
    const record: (typeof records)[number] = { name: name.name, type, data }
    if (type === 12) record.target = readName(buffer, dataOffset).name
    if (type === 33 && data.length >= 7) {
      record.port = data.readUInt16BE(4)
      record.target = readName(buffer, dataOffset + 6).name
    }
    if (type === 16) record.txt = parseTxt(data)
    if (type === 1 && data.length === 4) record.target = [...data].join('.')
    records.push(record)
  }

  const srv = new Map<string, { host?: string; port?: number }>()
  const txt = new Map<string, Record<string, string>>()
  const addresses = new Map<string, string[]>()
  for (const record of records) {
    if (record.type === 33) srv.set(record.name, { host: record.target, port: record.port })
    if (record.type === 16 && record.txt) txt.set(record.name, record.txt)
    if (record.type === 1 && record.target) addresses.set(record.name, unique([...(addresses.get(record.name) ?? []), record.target]))
  }

  const devices: NetworkDevice[] = []
  for (const [instance, service] of srv.entries()) {
    const serviceType = serviceFromInstance(instance) ?? 'mdns'
    const serviceTxt = txt.get(instance) ?? {}
    const ips = unique([...(service.host ? addresses.get(service.host) ?? [] : []), isPrivateIp(remoteAddress) ? remoteAddress : undefined])
    const name = serviceTxt.fn || serviceTxt.n || instance.replace(new RegExp(`\\.${serviceType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '')
    const port = service.port
    const category = categoryFor(serviceType, serviceTxt.mn, serviceTxt.md)
    const webUrls = port && ips[0] && ['_http._tcp.local', '_home-assistant._tcp.local'].includes(serviceType)
      ? [`http://${ips[0]}:${port}/`]
      : port && ips[0] && serviceType === '_https._tcp.local'
        ? [`https://${ips[0]}:${port}/`]
        : port === 8008 && ips[0]
          ? [`http://${ips[0]}:8008/setup/eureka_info`]
          : []
    devices.push(
      nowDevice({
        id: hashId(serviceTxt.id || `${ips[0] ?? service.host ?? instance}|${serviceType}`),
        source: 'mdns',
        name,
        hostname: service.host,
        addresses: ips,
        primaryIp: ips[0],
        manufacturer: serviceTxt.mn,
        model: serviceTxt.md || serviceTxt.fn,
        deviceType: serviceType,
        category,
        ports: port ? [port] : [],
        webUrls,
        services: [{ name, type: serviceType, protocol: 'mdns', port, hostname: service.host, addresses: ips, txt: serviceTxt }],
        raw: { mdnsTxt: serviceTxt }
      })
    )
  }
  return devices
}

async function discoverMdns(logs: string[]): Promise<NetworkDevice[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const devices: NetworkDevice[] = []
    const done = (): void => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      appendLog(logs, `mDNS found ${devices.length} service record${devices.length === 1 ? '' : 's'}.`)
      resolve(mergeDevices(devices))
    }
    socket.on('message', (message, remote) => {
      if (!isPrivateIp(remote.address)) return
      try {
        devices.push(...parseMdnsPacket(message, remote.address))
      } catch (error) {
        appendLog(logs, `mDNS parse skipped one packet: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    socket.on('error', (error) => {
      appendLog(logs, `mDNS failed: ${error.message}`)
      done()
    })
    socket.bind(() => {
      try {
        socket.setMulticastTTL(2)
        socket.send(buildMdnsQuery(), MDNS_PORT, MDNS_ADDRESS)
      } catch (error) {
        appendLog(logs, `mDNS query failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      setTimeout(done, 2400)
    })
  })
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim()
}

async function deviceFromSsdp(headers: Record<string, string>, remoteAddress: string, logs: string[]): Promise<NetworkDevice | undefined> {
  const location = headers.location ? safeHttpUrl(headers.location) : undefined
  let friendlyName = headers.usn || headers.st || remoteAddress
  let manufacturer: string | undefined
  let model: string | undefined
  let deviceType = headers.st
  let presentationUrl: string | undefined
  let iconUrl: string | undefined
  const services: NetworkDeviceService[] = []
  if (location) {
    try {
      const { text } = await fetchPrivateNetworkText(location, 1600)
      friendlyName = tag(text, 'friendlyName') || friendlyName
      manufacturer = tag(text, 'manufacturer')
      model = tag(text, 'modelName')
      deviceType = tag(text, 'deviceType') || deviceType
      const presentation = tag(text, 'presentationURL')
      if (presentation) presentationUrl = safeHttpUrl(new URL(presentation, location).toString())
      const icon = tag(text, 'url')
      if (icon) iconUrl = safeHttpUrl(new URL(icon, location).toString())
      for (const match of text.matchAll(/<serviceType[^>]*>([\s\S]*?)<\/serviceType>/gi)) {
        const type = match[1].trim()
        services.push({ name: type.split(':').pop() ?? type, type, protocol: 'ssdp' })
      }
    } catch (error) {
      appendLog(logs, `SSDP description fetch failed for ${remoteAddress}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const webUrls = unique([presentationUrl, location])
  return nowDevice({
    id: hashId(headers.usn || `${remoteAddress}|${deviceType ?? 'ssdp'}`),
    source: 'ssdp',
    name: friendlyName,
    hostname: location ? new URL(location).hostname : undefined,
    addresses: [remoteAddress],
    primaryIp: remoteAddress,
    manufacturer,
    model,
    deviceType,
    category: categoryFor(`${deviceType ?? ''} ${headers.server ?? ''}`, manufacturer, model),
    services,
    ports: webUrls.map((url) => Number(new URL(url).port || (url.startsWith('https:') ? 443 : 80))),
    webUrls,
    presentationUrl,
    iconUrl,
    raw: { ssdpHeaders: headers }
  })
}

async function discoverSsdp(logs: string[]): Promise<NetworkDevice[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    const responses = new Map<string, { headers: Record<string, string>; remote: string }>()
    const message = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: ssdp:all\r\n\r\n'
    )
    const finish = async (): Promise<void> => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      const devices = (
        await Promise.all([...responses.values()].map(({ headers, remote }) => deviceFromSsdp(headers, remote, logs)))
      ).filter((device): device is NetworkDevice => Boolean(device))
      appendLog(logs, `SSDP found ${devices.length} device${devices.length === 1 ? '' : 's'}.`)
      resolve(mergeDevices(devices))
    }
    socket.on('message', (buffer, remote) => {
      if (!isPrivateIp(remote.address)) return
      const headers = parseHeaders(buffer.toString('utf8'))
      const key = headers.usn || headers.location || `${remote.address}-${headers.st ?? ''}`
      responses.set(key, { headers, remote: remote.address })
    })
    socket.on('error', (error) => {
      appendLog(logs, `SSDP failed: ${error.message}`)
      void finish()
    })
    socket.bind(() => {
      socket.send(message, SSDP_PORT, SSDP_ADDRESS)
      setTimeout(() => void finish(), 2600)
    })
  })
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function discoverArp(logs: string[]): Promise<NetworkDevice[]> {
  try {
    const output = await execFileText('arp', ['-a'])
    const devices: NetworkDevice[] = []
    for (const line of output.split(/\r?\n/)) {
      const ip = line.match(/(?:\(|\s)(\d{1,3}(?:\.\d{1,3}){3})(?:\)|\s)/)?.[1]
      const mac = line.match(/([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i)?.[1]?.replace(/-/g, ':').toLowerCase()
      if (!ip || !isPrivateIp(ip)) continue
      devices.push(
        nowDevice({
          id: hashId(mac || ip),
          source: 'arp',
          name: `Device ${ip}`,
          addresses: [ip],
          primaryIp: ip,
          macAddress: mac,
          category: 'unknown',
          raw: { arp: line.trim() }
        })
      )
    }
    appendLog(logs, `ARP table exposed ${devices.length} local neighbor${devices.length === 1 ? '' : 's'}.`)
    return devices
  } catch (error) {
    appendLog(logs, `ARP lookup unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

function localProbeTargets(includeVpnAdapters: boolean, arpDevices: NetworkDevice[]): string[] {
  const adapters = os.networkInterfaces()
  const targets = new Set<string>()
  for (const device of arpDevices) if (device.primaryIp) targets.add(device.primaryIp)
  for (const [name, infos] of Object.entries(adapters)) {
    if (!infos) continue
    if (!includeVpnAdapters && /vpn|tun|tap|virtual|vmware|vbox|hyper-v/i.test(name)) continue
    for (const info of infos) {
      if (info.family !== 'IPv4' || info.internal || !isPrivateIp(info.address)) continue
      const prefix = info.cidr ? Number(info.cidr.split('/')[1]) : 24
      const safePrefix = prefix >= 24 && prefix <= 30 ? prefix : 24
      const base = ipv4ToNumber(info.address) & (0xffffffff << (32 - safePrefix))
      const size = Math.min(2 ** (32 - safePrefix) - 2, 120)
      for (let i = 1; i <= size; i += 1) {
        const ip = numberToIpv4((base + i) >>> 0)
        if (ip !== info.address && isPrivateIp(ip)) targets.add(ip)
      }
    }
  }
  return [...targets].slice(0, 160)
}

async function probeUrl(url: string, timeoutMs: number): Promise<{ title?: string; server?: string; ok: boolean }> {
  const { text, headers } = await fetchPrivateNetworkText(url, timeoutMs)
  return {
    title: text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80),
    server: headers.get('server') ?? undefined,
    ok: true
  }
}

async function fetchChromecastInfo(ip: string): Promise<Partial<NetworkDevice> | undefined> {
  try {
    const { text } = await fetchPrivateNetworkText(`http://${ip}:8008/setup/eureka_info?options=detail`, 1500)
    const json = JSON.parse(text) as Record<string, unknown>
    const deviceInfo = (json.device_info ?? {}) as Record<string, unknown>
    const name = String(json.name || deviceInfo.name || 'Chromecast')
    const model = String(deviceInfo.model_name || deviceInfo.model || json.model_name || '')
    const manufacturer = String(deviceInfo.manufacturer || 'Google')
    const app = typeof json.app_device_id === 'string' || typeof json.current_app === 'string' ? String(json.current_app || json.app_device_id) : undefined
    return {
      name,
      manufacturer,
      model,
      category: 'cast',
      deviceType: 'Chromecast',
      raw: { chromecast: { app, eureka: json } }
    }
  } catch {
    return undefined
  }
}

async function discoverProbe(settings: BrowserSettings['network'], arpDevices: NetworkDevice[], logs: string[]): Promise<NetworkDevice[]> {
  const targets = localProbeTargets(settings.includeVpnAdapters, arpDevices)
  const jobs: Array<() => Promise<NetworkDevice | undefined>> = []
  for (const ip of targets) {
    for (const port of PROBE_PORTS) {
      jobs.push(async () => {
        const scheme = port === 443 || port === 8443 || port === 5001 ? 'https' : 'http'
        const url = `${scheme}://${ip}:${port}/`
        try {
          const probed = await probeUrl(url, settings.probeTimeoutMs)
          const chromecast = port === 8008 ? await fetchChromecastInfo(ip) : undefined
          return nowDevice({
            id: hashId(`${ip}|probe`),
            source: 'probe',
            name: chromecast?.name || probed.title || `Web panel ${ip}`,
            addresses: [ip],
            primaryIp: ip,
            manufacturer: chromecast?.manufacturer,
            model: chromecast?.model,
            deviceType: chromecast?.deviceType || probed.server,
            category: (chromecast?.category as NetworkDeviceCategory | undefined) ?? categoryFor(`${port} ${probed.server ?? ''} ${probed.title ?? ''}`),
            ports: [port],
            webUrls: [url],
            raw: { probe: { title: probed.title, server: probed.server }, ...(chromecast?.raw ?? {}) }
          })
        } catch {
          return undefined
        }
      })
    }
  }

  const devices: NetworkDevice[] = []
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor]
      cursor += 1
      const device = await job()
      if (device) devices.push(device)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.probeConcurrency, 32)) }, () => worker()))
  appendLog(logs, `Active probe checked ${targets.length} local address${targets.length === 1 ? '' : 'es'} and found ${devices.length} web panel${devices.length === 1 ? '' : 's'}.`)
  return mergeDevices(devices)
}

function mockDevices(): NetworkDevice[] {
  const now = Date.now()
  return [
    nowDevice({
      id: 'net-mock-chromecast',
      source: 'mock',
      sources: ['mock', 'mdns'],
      name: 'Living Room Chromecast',
      hostname: 'living-room.local',
      addresses: ['192.168.1.42'],
      primaryIp: '192.168.1.42',
      manufacturer: 'Google',
      model: 'Chromecast HD',
      deviceType: '_googlecast._tcp.local',
      category: 'cast',
      services: [{ name: 'Living Room Chromecast', type: '_googlecast._tcp.local', protocol: 'mdns', port: 8008, txt: { fn: 'Living Room Chromecast', md: 'Chromecast HD' } }],
      ports: [8008, 8009],
      webUrls: ['http://192.168.1.42:8008/setup/eureka_info'],
      firstSeenAt: now - 120000,
      lastSeenAt: now
    }),
    nowDevice({
      id: 'net-mock-home-assistant',
      source: 'mock',
      sources: ['mock', 'probe'],
      name: 'Home Assistant',
      addresses: ['192.168.1.20'],
      primaryIp: '192.168.1.20',
      deviceType: 'Home Assistant Web UI',
      category: 'smart-home',
      services: [{ name: 'Home Assistant', type: '_home-assistant._tcp.local', protocol: 'mdns', port: 8123 }],
      ports: [8123],
      webUrls: ['http://192.168.1.20:8123/'],
      firstSeenAt: now - 60000,
      lastSeenAt: now
    })
  ]
}

export async function getNetworkDevices(): Promise<NetworkScanResult> {
  const store = await loadStore()
  return {
    devices: store.devices.map((device) => applyKnown(device, store)),
    logs: store.logs,
    startedAt: store.lastScanAt,
    finishedAt: store.lastScanAt,
    scanning: Boolean(activeScan)
  }
}

export async function scanNetwork(settings: BrowserSettings['network'], options: NetworkScanOptions = {}): Promise<NetworkScanResult> {
  if (activeScan) return activeScan
  activeScan = (async () => {
    if (!settings.enabled) throw new Error('Network Devices is disabled in settings.')
    if (!settings.allowScans && options.confirmed !== true && options.mock !== true) {
      throw new Error('Local network scan requires explicit confirmation.')
    }
    const store = await loadStore()
    const logs: string[] = []
    const startedAt = Date.now()
    appendLog(logs, options.mock ? 'Loading mock network inventory for tests.' : 'Manual local network scan started.')
    const discovered: NetworkDevice[] = []

    if (options.mock) {
      discovered.push(...mockDevices())
    } else {
      const arpDevices = options.arp !== false ? await discoverArp(logs) : []
      discovered.push(...arpDevices)
      const tasks: Array<Promise<NetworkDevice[]>> = []
      if (settings.passiveDiscovery && options.mdns !== false) tasks.push(discoverMdns(logs))
      if (settings.passiveDiscovery && options.ssdp !== false) tasks.push(discoverSsdp(logs))
      if (settings.activeProbing && options.probe === true) tasks.push(discoverProbe(settings, arpDevices, logs))
      const results = await Promise.allSettled(tasks)
      for (const result of results) {
        if (result.status === 'fulfilled') discovered.push(...result.value)
        else appendLog(logs, `Discovery source failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      }
    }

    const online = mergeDevices(discovered).map((device) => applyKnown(device, store))
    const offline = store.devices
      .filter((known) => !online.some((device) => device.id === known.id))
      .map((device) => ({ ...applyKnown(device, store), online: false }))
    const devices = mergeDevices([...online, ...offline])
    appendLog(logs, `Scan complete: ${online.length} online, ${offline.length} remembered.`)
    const finishedAt = Date.now()
    if (settings.rememberDevices || options.mock) {
      const known = { ...store.known }
      for (const device of devices) {
        known[device.id] = {
          alias: device.alias,
          favorite: device.favorite,
          pinned: device.pinned,
          notes: device.notes,
          firstSeenAt: device.firstSeenAt
        }
      }
      await saveStore({ devices, known, logs: [...store.logs, ...logs].slice(-200), lastScanAt: finishedAt })
    }
    return { devices, logs, startedAt, finishedAt, scanning: false }
  })()
  try {
    return await activeScan
  } finally {
    activeScan = null
  }
}

export async function updateNetworkDevice(id: string, patch: NetworkDevicePatch): Promise<NetworkDevice> {
  const store = await loadStore()
  const existing = store.devices.find((device) => device.id === id)
  if (!existing) throw new Error('Network device not found.')
  store.known[id] = {
    ...store.known[id],
    alias: typeof patch.alias === 'string' ? patch.alias.trim().slice(0, 80) : store.known[id]?.alias,
    favorite: typeof patch.favorite === 'boolean' ? patch.favorite : store.known[id]?.favorite,
    pinned: typeof patch.pinned === 'boolean' ? patch.pinned : store.known[id]?.pinned,
    notes: typeof patch.notes === 'string' ? patch.notes.slice(0, 2000) : store.known[id]?.notes,
    firstSeenAt: store.known[id]?.firstSeenAt ?? existing.firstSeenAt
  }
  const next = applyKnown(existing, store)
  store.devices = store.devices.map((device) => (device.id === id ? next : device))
  await saveStore(store)
  return next
}

export async function forgetNetworkDevice(id: string): Promise<void> {
  const store = await loadStore()
  delete store.known[id]
  store.devices = store.devices.filter((device) => device.id !== id)
  await saveStore(store)
}

export async function clearNetworkCache(): Promise<void> {
  await saveStore({ devices: [], known: {}, logs: [] })
}

export async function exportNetworkInventory(mainWindow: BrowserWindow): Promise<{ path?: string }> {
  const store = await loadStore()
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Vast network inventory',
    defaultPath: 'vast-network-devices.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) throw new Error('Export cancelled.')
  await writeFile(result.filePath, `${JSON.stringify({ devices: store.devices, exportedAt: Date.now() }, null, 2)}\n`, 'utf8')
  return { path: result.filePath }
}
