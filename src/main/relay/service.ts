import type {
  RelayActionResult,
  RelayBuildConfig,
  RelayCheckinRequest,
  RelayClientSnapshot,
  RelayInstanceKind,
  RelayPresentation,
  RelayReleasePayload
} from '../../shared/relay-types.ts'
import { verifyRelayEnvelope } from './crypto.ts'
import { downloadRelayMedia, RelayMediaCache, type RelayFetch } from './media.ts'
import { RelayMessageState, relayPresentation } from './message-state.ts'
import {
  parseRelayResponse,
  relayBroadcastIsActive,
  relayReleaseIsEligible,
  strictSemVer
} from './protocol.ts'
import {
  RELAY_MAX_RETRIES,
  relayHttpFailureIsTransient,
  relayPeriodicDelay,
  relayRetryAfterDelay,
  relayRetryDelay
} from './retry.ts'
import type { RelayLocalState, RelayStateStore } from './storage.ts'

const MAX_RESPONSE_BYTES = 256 * 1024
const CHECKIN_TIMEOUT_MS = 7_500
export const RELAY_STARTUP_DELAY_MS = 3_000
const MAX_SERVER_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000

interface RelayTimer {
  cancel(): void
}

interface RelayScheduler {
  schedule(callback: () => void, delayMs: number): RelayTimer
}

const defaultScheduler: RelayScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return { cancel: () => clearTimeout(timer) }
  }
}

export interface VastRelayServiceOptions {
  config: RelayBuildConfig
  stateStore: RelayStateStore
  fetcher: RelayFetch
  currentVersion: () => string
  instanceKind: RelayInstanceKind
  emitSnapshot: (snapshot: RelayClientSnapshot) => void
  openExternal: (url: string) => Promise<void>
  applyTrustedUpdate: () => Promise<boolean>
  checkinTimeoutMs?: number
  now?: () => number
  random?: () => number
  scheduler?: RelayScheduler
}

class RelayAttemptError extends Error {
  readonly transient: boolean
  readonly retryAfterMs?: number

  constructor(message: string, transient: boolean, retryAfterMs?: number) {
    super(message)
    this.transient = transient
    this.retryAfterMs = retryAfterMs
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new RelayAttemptError('Relay response is oversized.', false)
  }
  if (!response.body) throw new RelayAttemptError('Relay response is empty.', false)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RelayAttemptError('Relay response is oversized.', false)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total < 2) throw new RelayAttemptError('Relay response is empty.', false)
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
}

function productionReleaseUrlAllowed(payload: RelayReleasePayload): boolean {
  const url = new URL(payload.release_url)
  if (url.origin === 'https://releases.vastbrowser.com') return true
  if (url.origin === 'https://vastbrowser.com' || url.origin === 'https://www.vastbrowser.com') return true
  return url.origin === 'https://github.com' && url.pathname.startsWith('/vstxx/vast-public/')
}

function safeError(): RelayActionResult {
  return { ok: false, error: 'The Relay action could not be completed safely.' }
}

export class VastRelayService {
  private readonly options: Required<Pick<VastRelayServiceOptions, 'now' | 'random' | 'scheduler'>> & VastRelayServiceOptions
  private readonly messageState = new RelayMessageState()
  private readonly mediaCache = new RelayMediaCache()
  private localState: RelayLocalState | undefined
  private currentPresentation: RelayPresentation | null = null
  private timer: RelayTimer | undefined
  private requestController: AbortController | undefined
  private started = false
  private stopped = false
  private inFlight = false
  private presentationGeneration = 0

  constructor(options: VastRelayServiceOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      scheduler: options.scheduler ?? defaultScheduler
    }
  }

  snapshot(): RelayClientSnapshot {
    return {
      enabled: this.options.config.enabled,
      environment: this.options.config.environment,
      current: this.currentPresentation,
      pendingCount: this.messageState.pendingCount()
    }
  }

  refreshPresentationTarget(): void {
    if (this.started && !this.stopped) this.options.emitSnapshot(this.snapshot())
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      this.localState = await this.options.stateStore.beginLaunch(this.options.now())
    } catch {
      console.warn('[relay] Local installation state is unavailable; Relay is disabled for this launch.')
      return
    }
    if (!this.options.config.enabled) {
      this.options.emitSnapshot(this.snapshot())
      return
    }
    if (this.stopped) return
    this.schedule(RELAY_STARTUP_DELAY_MS, 0)
  }

  stop(): void {
    this.stopped = true
    this.timer?.cancel()
    this.timer = undefined
    this.requestController?.abort()
    this.requestController = undefined
  }

  async dismiss(presentationId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.currentPresentation || this.currentPresentation.presentationId !== presentationId) return safeError()
    try {
      this.localState = await this.options.stateStore.dismiss(presentationId, this.options.now())
      if (!this.messageState.dismiss(presentationId)) return safeError()
      await this.publishCurrent()
      return { ok: true }
    } catch {
      return safeError()
    }
  }

  async performAction(presentationId: string): Promise<RelayActionResult> {
    if (!this.currentPresentation || this.currentPresentation.presentationId !== presentationId) return safeError()
    const item = this.messageState.find(presentationId)
    if (!item) return safeError()
    try {
      if (item.kind === 'message') {
        if (!item.payload.action) return safeError()
        await this.options.openExternal(item.payload.action.url)
        return { ok: true, outcome: 'external' }
      }
      if (await this.options.applyTrustedUpdate()) return { ok: true, outcome: 'trusted-updater' }
      if (!productionReleaseUrlAllowed(item.payload)) return safeError()
      await this.options.openExternal(item.payload.release_url)
      return { ok: true, outcome: 'external' }
    } catch {
      return safeError()
    }
  }

  private schedule(delayMs: number, retryIndex: number): void {
    if (this.stopped) return
    this.timer?.cancel()
    this.timer = this.options.scheduler.schedule(() => {
      this.timer = undefined
      void this.attempt(retryIndex)
    }, delayMs)
  }

  private schedulePeriodic(): void {
    this.schedule(relayPeriodicDelay(this.options.random()), 0)
  }

  private async attempt(retryIndex: number): Promise<void> {
    if (this.stopped || this.inFlight || !this.localState) return
    this.inFlight = true
    try {
      await this.checkin(this.localState)
      this.schedulePeriodic()
    } catch (error) {
      const failure = error instanceof RelayAttemptError ? error : new RelayAttemptError('Relay network failure.', true)
      if (failure.transient && retryIndex < RELAY_MAX_RETRIES) {
        const delay = failure.retryAfterMs ?? relayRetryDelay(retryIndex, this.options.random())
        if (delay !== null) this.schedule(delay, retryIndex + 1)
        else this.schedulePeriodic()
      } else {
        this.schedulePeriodic()
      }
      console.warn(`[relay] Check-in failed safely (${failure.transient ? 'temporary' : 'non-retryable'}).`)
    } finally {
      this.inFlight = false
    }
  }

  private async checkin(localState: RelayLocalState): Promise<void> {
    const currentVersion = strictSemVer(this.options.currentVersion(), 'Current Vast version')
    const body: RelayCheckinRequest = {
      protocol: 1,
      install_id: localState.installId,
      current_version: currentVersion,
      launch_count: localState.launchCount,
      instance_kind: this.options.instanceKind
    }
    const controller = new AbortController()
    this.requestController = controller
    const timeout = setTimeout(() => controller.abort(), this.options.checkinTimeoutMs ?? CHECKIN_TIMEOUT_MS)
    let response: Response
    let responseText: string
    try {
      try {
        response = await this.options.fetcher(new URL('/v1/checkin', `${this.options.config.endpoint}/`), {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Vast-Relay/1'
          },
          body: JSON.stringify(body)
        })
      } catch {
        throw new RelayAttemptError('Relay network failure.', true)
      }

      if (response.status === 429) {
        throw new RelayAttemptError(
          'Relay rate limit.',
          true,
          relayRetryAfterDelay(response.headers.get('retry-after'), this.options.now())
        )
      }
      if (!response.ok) throw new RelayAttemptError(`Relay HTTP ${response.status}.`, relayHttpFailureIsTransient(response.status))
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') throw new RelayAttemptError('Relay response MIME is invalid.', false)
      responseText = await readBoundedResponseText(response)
    } catch (error) {
      if (error instanceof RelayAttemptError) throw error
      throw new RelayAttemptError('Relay network failure.', true)
    } finally {
      clearTimeout(timeout)
      if (this.requestController === controller) this.requestController = undefined
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(responseText) as unknown
    } catch {
      throw new RelayAttemptError('Relay response JSON is invalid.', false)
    }
    let parsed
    try {
      parsed = parseRelayResponse(decoded)
    } catch {
      throw new RelayAttemptError('Relay response schema is invalid.', false)
    }
    if (Math.abs(Date.parse(parsed.serverTime) - this.options.now()) > MAX_SERVER_CLOCK_SKEW_MS) {
      throw new RelayAttemptError('Relay server timestamp is implausible.', false)
    }

    const now = this.options.now()
    const messages = parsed.messages.filter((message) => {
      const valid = verifyRelayEnvelope(message, this.options.config.keys)
      return valid && relayBroadcastIsActive(message.payload, currentVersion, now)
    })
    const update = parsed.update &&
      verifyRelayEnvelope(parsed.update, this.options.config.keys) &&
      relayReleaseIsEligible(parsed.update.payload, currentVersion, now)
      ? parsed.update
      : null
    const dismissed = new Set(localState.dismissed.map((entry) => entry.id))
    this.messageState.replace(messages, update, dismissed)
    await this.publishCurrent()
  }

  private async publishCurrent(): Promise<void> {
    const generation = ++this.presentationGeneration
    const current = this.messageState.current()
    if (!current) {
      this.currentPresentation = null
      this.options.emitSnapshot(this.snapshot())
      return
    }
    const cached = current.kind === 'message' && current.payload.media
      ? this.mediaCache.get(current.payload.media)
      : undefined
    const currentVersion = strictSemVer(this.options.currentVersion(), 'Current Vast version')
    this.currentPresentation = relayPresentation(current, cached ?? null, currentVersion)
    this.options.emitSnapshot(this.snapshot())
    if (cached || current.kind !== 'message' || !current.payload.media) return
    try {
      const downloaded = await downloadRelayMedia(
        this.options.config.endpoint,
        current.payload.media,
        this.options.fetcher
      )
      if (generation !== this.presentationGeneration || this.messageState.current()?.presentationId !== current.presentationId) return
      this.mediaCache.set(current.payload.media, downloaded)
      this.currentPresentation = relayPresentation(current, downloaded, currentVersion)
      this.options.emitSnapshot(this.snapshot())
    } catch {
      // Signed text remains displayable when optional media fails validation or transport.
    }
  }
}
