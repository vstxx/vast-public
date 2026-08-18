import type {
  RelayBroadcastPayload,
  RelayMessagePresentation,
  RelayPresentation,
  RelayPresentationMedia,
  RelayReleasePayload,
  RelaySignedEnvelope,
  RelayUpdatePresentation
} from '../../shared/relay-types.ts'
import semver from 'semver'

export type RelayQueueItem =
  | { kind: 'message'; presentationId: string; payload: RelayBroadcastPayload }
  | { kind: 'update'; presentationId: string; payload: RelayReleasePayload }

function messageScore(payload: RelayBroadcastPayload): number {
  const typeScore = {
    welcome: 900,
    seasonal: 1_000,
    announcement: 2_000,
    update_notice: 4_000,
    security: 5_000
  }[payload.type]
  return typeScore + payload.priority
}

function updateScore(payload: RelayReleasePayload): number {
  return {
    optional: 1_500,
    recommended: 2_500,
    important: 4_500,
    critical: 6_500
  }[payload.severity]
}

function score(item: RelayQueueItem): number {
  return item.kind === 'message' ? messageScore(item.payload) : updateScore(item.payload)
}

export class RelayMessageState {
  private queue: RelayQueueItem[] = []

  replace(
    messages: readonly RelaySignedEnvelope<RelayBroadcastPayload>[],
    update: RelaySignedEnvelope<RelayReleasePayload> | null,
    dismissedIds: ReadonlySet<string>
  ): void {
    const items: RelayQueueItem[] = messages.map((message) => ({
      kind: 'message',
      presentationId: `broadcast:${message.payload.id}`,
      payload: message.payload
    }))
    if (update) {
      items.push({
        kind: 'update',
        presentationId: `release:${update.payload.version}`,
        payload: update.payload
      })
    }
    const unique = new Map<string, RelayQueueItem>()
    for (const item of items) {
      if (!dismissedIds.has(item.presentationId) && !unique.has(item.presentationId)) unique.set(item.presentationId, item)
    }
    this.queue = [...unique.values()].sort((left, right) => {
      const priority = score(right) - score(left)
      if (priority !== 0) return priority
      const leftTime = left.kind === 'message' ? Date.parse(left.payload.active_from) : Date.parse(left.payload.published_at)
      const rightTime = right.kind === 'message' ? Date.parse(right.payload.active_from) : Date.parse(right.payload.published_at)
      return leftTime - rightTime || left.presentationId.localeCompare(right.presentationId)
    })
  }

  current(): RelayQueueItem | undefined {
    return this.queue[0]
  }

  find(presentationId: string): RelayQueueItem | undefined {
    return this.queue.find((item) => item.presentationId === presentationId)
  }

  dismiss(presentationId: string): boolean {
    if (this.queue[0]?.presentationId !== presentationId) return false
    this.queue.shift()
    return true
  }

  pendingCount(): number {
    return this.queue.length
  }
}

export function relayPresentation(
  item: RelayQueueItem,
  media: RelayPresentationMedia | null,
  currentVersion?: string
): RelayPresentation {
  if (item.kind === 'message') {
    const presentation: RelayMessagePresentation = {
      kind: 'message',
      presentationId: item.presentationId,
      broadcastId: item.payload.id,
      type: item.payload.type,
      title: item.payload.title,
      body: item.payload.body,
      actionLabel: item.payload.action?.label ?? null,
      media
    }
    return presentation
  }
  const presentation: RelayUpdatePresentation = {
    kind: 'update',
    presentationId: item.presentationId,
    version: item.payload.version,
    severity: item.payload.severity,
    title: item.payload.title,
    body: item.payload.notes,
    minimumSupportedVersion: item.payload.min_supported_version,
    isBelowMinimumSupported: Boolean(
      currentVersion && item.payload.min_supported_version && semver.lt(currentVersion, item.payload.min_supported_version)
    )
  }
  return presentation
}
