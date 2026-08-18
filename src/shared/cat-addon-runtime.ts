export type CatLoopMode = 'once' | 'repeat' | 'reverse' | 'ping-pong'
export type CatFacing = 'left' | 'right'

export interface CatAtlasFrame {
  index: number
  source_frame: number
  x: number
  y: number
  duration_ms: number
}

export interface CatAnimationDefinition {
  id: string
  source_tag: string
  source_range: [number, number]
  source_direction: 'forward' | 'reverse' | 'ping-pong' | 'ping-pong-reverse'
  source_repeat: number
  frames: CatAtlasFrame[]
  loop: CatLoopMode
  total_duration_ms: number
  baseline_y: number
  anchor: { x: number; y: number }
  facing: CatFacing
  cancellable: boolean
  roles: string[]
}

export interface CatAnimationMetadata {
  format_version: 2
  source: {
    archive: string
    asset: string
    sha256: string
    frame_count: number
    tag_count: number
    frame_size: { width: number; height: number }
  }
  atlas: {
    path: string
    width: number
    height: number
    frame_width: number
    frame_height: number
    columns: number
    frames: number
    decoded_bytes: number
    image_rendering: 'pixelated'
  }
  animations: CatAnimationDefinition[]
}

export interface CatAddonRuntimeBundle {
  atlasDataUrl: string
  metadata: CatAnimationMetadata
}

export const REQUIRED_CAT_ANIMATIONS = [
  'idle_1', 'walk', 'sit', 'sit_tilt', 'idle_tilt', 'sit_lift', 'idle_lift',
  'yes', 'sit_no', 'dance', 'stand_up', 'sit_down', 'jump_1', 'run_1',
  'rest_1', 'rest_2', 'rest_4', 'dream', 'spawn_1', 'attack_1', 'push',
  'pull_back', 'climb_1', 'climb_2', 'climb_3', 'climb_jump_1',
  'scratch_start', 'scratch_1', 'scratch_end'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

export function parseCatAnimationMetadata(value: unknown): CatAnimationMetadata {
  if (!isRecord(value) || value.format_version !== 2 || !isRecord(value.source) || !isRecord(value.atlas) || !Array.isArray(value.animations)) {
    throw new Error('Cat animation metadata root is invalid.')
  }
  const source = value.source
  if (
    source.archive !== 'Cat_85_Animations.zip' || source.asset !== 'Cat_Grey_White.aseprite' ||
    typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) ||
    source.frame_count !== 483 || !boundedInteger(source.tag_count, 1, 256) || !isRecord(source.frame_size) ||
    source.frame_size.width !== 32 || source.frame_size.height !== 32
  ) throw new Error('Cat animation source metadata is invalid.')

  const atlas = value.atlas
  if (
    atlas.path !== 'assets/cat_grey_white.png' || atlas.image_rendering !== 'pixelated' ||
    !boundedInteger(atlas.width, 32, 2048) || !boundedInteger(atlas.height, 32, 2048) ||
    atlas.frame_width !== 32 || atlas.frame_height !== 32 ||
    !boundedInteger(atlas.columns, 1, 64) || !boundedInteger(atlas.frames, 1, 512) ||
    atlas.columns !== Number(atlas.width) / 32 || Number(atlas.height) % 32 !== 0 ||
    Number(atlas.frames) > Number(atlas.width) / 32 * (Number(atlas.height) / 32) ||
    atlas.decoded_bytes !== Number(atlas.width) * Number(atlas.height) * 4
  ) throw new Error('Cat animation atlas metadata is invalid.')

  if (value.animations.length < REQUIRED_CAT_ANIMATIONS.length || value.animations.length > 96) {
    throw new Error('Cat animation list size is invalid.')
  }
  const ids = new Set<string>()
  for (const candidate of value.animations) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !/^[a-z0-9_]+$/.test(candidate.id) || ids.has(candidate.id)) {
      throw new Error('Cat animation ID is invalid or duplicated.')
    }
    ids.add(candidate.id)
    if (
      typeof candidate.source_tag !== 'string' || candidate.source_tag.length === 0 || candidate.source_tag.length > 64 ||
      !Array.isArray(candidate.source_range) || candidate.source_range.length !== 2 ||
      !boundedInteger(candidate.source_range[0], 0, 482) || !boundedInteger(candidate.source_range[1], candidate.source_range[0], 482) ||
      !['forward', 'reverse', 'ping-pong', 'ping-pong-reverse'].includes(String(candidate.source_direction)) ||
      !boundedInteger(candidate.source_repeat, 0, 1_000) ||
      !['once', 'repeat', 'reverse', 'ping-pong'].includes(String(candidate.loop)) ||
      typeof candidate.cancellable !== 'boolean' || !Array.isArray(candidate.roles) || candidate.roles.some((role) => typeof role !== 'string') ||
      !isRecord(candidate.anchor) || !boundedInteger(candidate.anchor.x, 0, 31) || !boundedInteger(candidate.anchor.y, 0, 31) ||
      !boundedInteger(candidate.baseline_y, 0, 31) || !['left', 'right'].includes(String(candidate.facing)) ||
      !Array.isArray(candidate.frames) || candidate.frames.length === 0 || candidate.frames.length > 64
    ) throw new Error(`Cat animation entry is invalid: ${candidate.id}`)
    let duration = 0
    for (const frame of candidate.frames) {
      if (
        !isRecord(frame) || !boundedInteger(frame.index, 0, Number(atlas.frames) - 1) ||
        !boundedInteger(frame.source_frame, Number(candidate.source_range[0]), Number(candidate.source_range[1])) ||
        !boundedInteger(frame.x, 0, Number(atlas.width) - 32) || !boundedInteger(frame.y, 0, Number(atlas.height) - 32) ||
        Number(frame.x) % 32 !== 0 || Number(frame.y) % 32 !== 0 ||
        frame.x !== Number(frame.index) % Number(atlas.columns) * 32 ||
        frame.y !== Math.floor(Number(frame.index) / Number(atlas.columns)) * 32 ||
        !boundedInteger(frame.duration_ms, 16, 2_000)
      ) throw new Error(`Cat animation frame is invalid: ${candidate.id}`)
      duration += Number(frame.duration_ms)
    }
    if (candidate.total_duration_ms !== duration) throw new Error(`Cat animation duration is stale: ${candidate.id}`)
  }
  for (const required of REQUIRED_CAT_ANIMATIONS) if (!ids.has(required)) throw new Error(`Required cat animation is missing: ${required}`)
  return value as unknown as CatAnimationMetadata
}

export function catAnimationMap(metadata: CatAnimationMetadata): ReadonlyMap<string, CatAnimationDefinition> {
  return new Map(metadata.animations.map((animation) => [animation.id, animation]))
}

export function catScaleForDpi(devicePixelRatio: number, desiredCssScale = 2): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return Math.max(1, Math.round(dpr * desiredCssScale)) / dpr
}

export function snapCatCoordinate(value: number, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return Math.round(value * dpr) / dpr
}
