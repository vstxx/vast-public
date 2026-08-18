import {
  catAnimationMap,
  type CatAnimationDefinition,
  type CatAnimationMetadata,
  type CatFacing
} from '../../../shared/cat-addon-runtime.ts'

export interface CatEngineClock {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface CatFrameSnapshot {
  animationId: string
  frameIndex: number
  atlasX: number
  atlasY: number
  sourceFrame: number
  baselineY: number
}

export interface CatActorSnapshot extends CatFrameSnapshot {
  visible: boolean
  x: number
  y: number
  facing: CatFacing
  transitionMs: number
}

export type CatPlaybackResult = 'completed' | 'cancelled'

export type CatSceneAction =
  | { type: 'show'; x: number; y: number; facing?: CatFacing }
  | { type: 'hide' }
  | { type: 'turn'; facing: CatFacing }
  | { type: 'play'; animation: string; cycles?: number; reverse?: boolean }
  | { type: 'move'; x: number; y: number; durationMs: number }
  | { type: 'travel'; animation: string; cycles: number; x: number; y: number; durationMs: number }
  | { type: 'wait'; durationMs: number }

function productionClock(): CatEngineClock {
  return {
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number)
  }
}

export class CatSpriteAtlas {
  readonly metadata: CatAnimationMetadata
  readonly animations: ReadonlyMap<string, CatAnimationDefinition>

  constructor(metadata: CatAnimationMetadata) {
    this.metadata = metadata
    this.animations = catAnimationMap(metadata)
  }

  animation(id: string): CatAnimationDefinition {
    const animation = this.animations.get(id)
    if (!animation) throw new Error(`Unknown Cat Addon animation: ${id}`)
    return animation
  }
}

interface ActivePlayback {
  token: number
  frames: CatAnimationDefinition['frames']
  animation: CatAnimationDefinition
  frameCursor: number
  completedCycles: number
  cycles: number
  remainingMs: number
  frameStartedAt: number
  resolve: (result: CatPlaybackResult) => void
}

export class CatAnimator {
  private readonly atlas: CatSpriteAtlas
  private readonly clock: CatEngineClock
  private readonly onFrame: (frame: CatFrameSnapshot) => void
  private active: ActivePlayback | undefined
  private timer: unknown
  private token = 0
  private visible = true
  private destroyed = false

  constructor(
    atlas: CatSpriteAtlas,
    onFrame: (frame: CatFrameSnapshot) => void,
    clock: CatEngineClock = productionClock()
  ) {
    this.atlas = atlas
    this.clock = clock
    this.onFrame = onFrame
  }

  play(id: string, options: { cycles?: number; reverse?: boolean; reducedMotion?: boolean } = {}): Promise<CatPlaybackResult> {
    if (this.destroyed) return Promise.resolve('cancelled')
    this.cancel()
    const animation = this.atlas.animation(id)
    const sourceFrames = options.reverse ? [...animation.frames].reverse() : animation.frames
    const frames = animation.loop === 'ping-pong' && sourceFrames.length > 1
      ? [...sourceFrames, ...sourceFrames.slice(1, -1).reverse()]
      : sourceFrames
    const cycles = Math.max(1, Math.min(1_000, Math.floor(options.cycles ?? 1)))
    const token = ++this.token
    if (options.reducedMotion) {
      this.emit(animation, frames[frames.length - 1])
      return Promise.resolve('completed')
    }
    return new Promise((resolve) => {
      this.active = {
        token,
        frames,
        animation,
        frameCursor: 0,
        completedCycles: 0,
        cycles,
        remainingMs: frames[0].duration_ms,
        frameStartedAt: this.clock.now(),
        resolve
      }
      this.emit(animation, frames[0])
      if (this.visible) this.arm()
    })
  }

  setVisible(visible: boolean): void {
    if (this.destroyed || this.visible === visible) return
    this.visible = visible
    if (!this.active) return
    if (!visible) {
      this.active.remainingMs = Math.max(0, this.active.remainingMs - (this.clock.now() - this.active.frameStartedAt))
      this.clearTimer()
    } else {
      this.active.frameStartedAt = this.clock.now()
      this.arm()
    }
  }

  cancel(): boolean {
    if (!this.active) return false
    const active = this.active
    this.active = undefined
    this.clearTimer()
    active.resolve('cancelled')
    return true
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancel()
  }

  private emit(animation: CatAnimationDefinition, frame: CatAnimationDefinition['frames'][number]): void {
    this.onFrame({
      animationId: animation.id,
      frameIndex: frame.index,
      atlasX: frame.x,
      atlasY: frame.y,
      sourceFrame: frame.source_frame,
      baselineY: animation.baseline_y
    })
  }

  private arm(): void {
    const active = this.active
    if (!active || !this.visible || this.destroyed) return
    active.frameStartedAt = this.clock.now()
    this.timer = this.clock.setTimeout(() => this.advance(active.token), active.remainingMs)
  }

  private advance(token: number): void {
    const active = this.active
    if (!active || active.token !== token || this.destroyed) return
    this.timer = undefined
    active.frameCursor += 1
    if (active.frameCursor >= active.frames.length) {
      active.completedCycles += 1
      if (active.completedCycles >= active.cycles) {
        this.active = undefined
        active.resolve('completed')
        return
      }
      active.frameCursor = 0
    }
    const frame = active.frames[active.frameCursor]
    active.remainingMs = frame.duration_ms
    this.emit(active.animation, frame)
    this.arm()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }
}

export class CatActor {
  readonly animator: CatAnimator
  private readonly clock: CatEngineClock
  private snapshot: CatActorSnapshot
  private movementTimer: unknown
  private movementResolve: ((result: CatPlaybackResult) => void) | undefined
  private destroyed = false
  private readonly onChanged: (snapshot: CatActorSnapshot) => void

  constructor(
    atlas: CatSpriteAtlas,
    initial: { animation: string; x: number; y: number; facing?: CatFacing; visible?: boolean },
    onChanged: (snapshot: CatActorSnapshot) => void,
    clock: CatEngineClock = productionClock()
  ) {
    this.clock = clock
    this.onChanged = onChanged
    const animation = atlas.animation(initial.animation)
    const frame = animation.frames[0]
    this.snapshot = {
      visible: initial.visible ?? true,
      x: initial.x,
      y: initial.y,
      facing: initial.facing ?? animation.facing,
      transitionMs: 0,
      animationId: animation.id,
      frameIndex: frame.index,
      atlasX: frame.x,
      atlasY: frame.y,
      sourceFrame: frame.source_frame,
      baselineY: animation.baseline_y
    }
    this.animator = new CatAnimator(atlas, (next) => this.update(next), clock)
  }

  getSnapshot(): CatActorSnapshot {
    return { ...this.snapshot }
  }

  show(x: number, y: number, facing: CatFacing = this.snapshot.facing): void {
    this.update({ visible: true, x, y, facing, transitionMs: 0 })
  }

  hide(): void { this.update({ visible: false, transitionMs: 0 }) }
  turn(facing: CatFacing): void { this.update({ facing, transitionMs: 0 }) }

  play(animation: string, options: { cycles?: number; reverse?: boolean; reducedMotion?: boolean } = {}): Promise<CatPlaybackResult> {
    return this.animator.play(animation, options)
  }

  moveTo(x: number, y: number, durationMs: number): Promise<CatPlaybackResult> {
    this.cancelMovement()
    if (this.destroyed) return Promise.resolve('cancelled')
    const boundedDuration = Math.max(0, Math.min(30_000, Math.round(durationMs)))
    this.update({ x, y, transitionMs: boundedDuration })
    if (boundedDuration === 0) return Promise.resolve('completed')
    return new Promise((resolve) => {
      this.movementResolve = resolve
      this.movementTimer = this.clock.setTimeout(() => {
        this.movementTimer = undefined
        this.movementResolve = undefined
        this.update({ transitionMs: 0 })
        resolve('completed')
      }, boundedDuration)
    })
  }

  cancel(): void {
    this.animator.cancel()
    this.cancelMovement()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancel()
    this.animator.destroy()
  }

  private cancelMovement(): void {
    if (this.movementTimer !== undefined) this.clock.clearTimeout(this.movementTimer)
    this.movementTimer = undefined
    const resolve = this.movementResolve
    this.movementResolve = undefined
    resolve?.('cancelled')
  }

  private update(next: Partial<CatActorSnapshot>): void {
    if (this.destroyed) return
    this.snapshot = { ...this.snapshot, ...next }
    this.onChanged(this.getSnapshot())
  }
}

export class CatSceneDirector {
  private generation = 0
  private destroyed = false
  private readonly waits = new Map<unknown, (result: CatPlaybackResult) => void>()
  private readonly actor: CatActor
  private readonly clock: CatEngineClock

  constructor(
    actor: CatActor,
    clock: CatEngineClock = productionClock()
  ) {
    this.actor = actor
    this.clock = clock
  }

  async run(actions: readonly CatSceneAction[], reducedMotion = false): Promise<CatPlaybackResult> {
    this.cancel()
    const generation = this.generation
    for (const action of actions) {
      if (this.destroyed || generation !== this.generation) return 'cancelled'
      let result: CatPlaybackResult = 'completed'
      switch (action.type) {
        case 'show': this.actor.show(action.x, action.y, action.facing); break
        case 'hide': this.actor.hide(); break
        case 'turn': this.actor.turn(action.facing); break
        case 'play':
          result = await this.actor.play(action.animation, { cycles: action.cycles, reverse: action.reverse, reducedMotion })
          break
        case 'move':
          result = await this.actor.moveTo(action.x, action.y, reducedMotion ? 0 : action.durationMs)
          break
        case 'travel': {
          const results = await Promise.all([
            this.actor.play(action.animation, { cycles: action.cycles, reducedMotion }),
            this.actor.moveTo(action.x, action.y, reducedMotion ? 0 : action.durationMs)
          ])
          result = results.includes('cancelled') ? 'cancelled' : 'completed'
          break
        }
        case 'wait': result = await this.wait(reducedMotion ? Math.min(650, action.durationMs) : action.durationMs, generation); break
      }
      if (result === 'cancelled') return result
    }
    return generation === this.generation ? 'completed' : 'cancelled'
  }

  cancel(): void {
    this.generation += 1
    this.actor.cancel()
    for (const [handle, resolve] of this.waits) {
      this.clock.clearTimeout(handle)
      resolve('cancelled')
    }
    this.waits.clear()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancel()
  }

  private wait(durationMs: number, generation: number): Promise<CatPlaybackResult> {
    if (durationMs <= 0) return Promise.resolve('completed')
    return new Promise((resolve) => {
      const handle = this.clock.setTimeout(() => {
        this.waits.delete(handle)
        resolve(generation === this.generation ? 'completed' : 'cancelled')
      }, durationMs)
      this.waits.set(handle, resolve)
    })
  }
}
