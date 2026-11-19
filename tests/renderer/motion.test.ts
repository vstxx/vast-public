import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Minimal stand-ins for the Web Animations surface motion.ts uses, so the
// lifecycle (enter, exit, interruption, fallback) is checked without a DOM.
class FakeAnimation {
  playState: AnimationPlayState = 'running'
  onfinish: (() => void) | null = null
  oncancel: (() => void) | null = null
  id = ''
  readonly frames: Keyframe[]
  readonly options: KeyframeAnimationOptions
  constructor(frames: Keyframe[], options: KeyframeAnimationOptions) {
    this.frames = frames
    this.options = options
  }
  cancel(): void { this.playState = 'idle'; this.oncancel?.() }
  finish(): void { this.playState = 'finished'; this.onfinish?.() }
}

class FakeElement {
  readonly animations: FakeAnimation[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  inert = false
  computed = { opacity: '1', transform: 'none' }
  animate(frames: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
    const animation = new FakeAnimation(frames, options)
    this.animations.push(animation)
    return animation
  }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  get last(): FakeAnimation { return this.animations.at(-1)! }
}

Object.assign(globalThis, {
  window: { setTimeout, clearTimeout },
  getComputedStyle: (element: FakeElement) => element.computed
})

const motion = await import('../../src/renderer/lib/motion.ts')
const element = (): Element => new FakeElement() as unknown as Element
const fake = (value: Element): FakeElement => value as unknown as FakeElement

test('the motion level: Off and reduced motion win, Enhanced is opt-in and capped by constrained graphics', () => {
  const resolve = motion.resolveMotionLevel
  assert.equal(resolve({ animations: false, preference: 'enhanced', reducedMotion: false, constrainedGraphics: false }), 'off')
  assert.equal(resolve({ animations: true, preference: 'enhanced', reducedMotion: true, constrainedGraphics: false }), 'off')
  assert.equal(resolve({ animations: true, preference: 'enhanced', reducedMotion: false, constrainedGraphics: false }), 'enhanced')
  assert.equal(resolve({ animations: true, preference: 'enhanced', reducedMotion: false, constrainedGraphics: true }), 'standard')
  assert.equal(resolve({ animations: true, preference: 'standard', reducedMotion: false, constrainedGraphics: false }), 'standard')
  assert.equal(resolve({ animations: true, preference: undefined, reducedMotion: false, constrainedGraphics: false }), 'standard', 'settings from before motionLevel existed')
})

test('timings stay inside the design targets; Enhanced is never shorter, never blurrier', () => {
  const targets: Record<string, [number, number, number, number]> = {
    menu: [130, 170, 170, 210], popover: [130, 170, 170, 210], context: [120, 160, 150, 190], dialog: [200, 250, 260, 310],
    panel: [190, 230, 240, 290], docked: [150, 230, 190, 290], toast: [180, 230, 220, 290]
  }
  for (const [kind, [standardMin, standardMax, enhancedMin, enhancedMax]] of Object.entries(targets)) {
    const standard = motion.motionSpec(kind as never, 'standard')!
    const enhanced = motion.motionSpec(kind as never, 'enhanced')!
    assert.ok(standard.duration >= standardMin && standard.duration <= standardMax, `${kind} standard ${standard.duration}`)
    assert.ok(enhanced.duration >= enhancedMin && enhanced.duration <= enhancedMax, `${kind} enhanced ${enhanced.duration}`)
    assert.ok(standard.scale >= 0.97 && enhanced.scale >= 0.97, `${kind} scale stays subtle`)
    assert.ok(standard.distance <= 16 && enhanced.distance <= 16, `${kind} travel stays small`)
  }
  assert.equal(motion.motionSpec('menu', 'off'), null)
  const source = readFileSync(new URL('../../src/renderer/lib/motion.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /filter|blur\(|box-shadow|boxShadow|will-change|requestAnimationFrame/, 'compositor-friendly properties only, no frame loop')
})

test('entrances and exits animate only opacity and transform; exits are faster', async () => {
  motion.setMotionLevel('standard')
  const target = element()
  motion.playEnter(target, 'menu')
  const enter = fake(target).last
  assert.deepEqual(Object.keys(enter.frames[0]).sort(), ['opacity', 'transform'])
  assert.deepEqual(enter.frames[1], { opacity: 1, transform: 'none' })
  assert.equal(enter.options.fill, undefined, 'a finished entrance leaves no held style or layer')
  enter.finish()
  let done = 0
  motion.playExit(target, 'menu', () => { done += 1 })
  const exit = fake(target).last
  assert.ok(Number(exit.options.duration) < Number(enter.options.duration))
  assert.equal(exit.options.fill, 'forwards', 'hidden until removed, so nothing flashes back')
  exit.finish()
  assert.equal(done, 1)
})

test('a surface below its anchor drops in; one opened upward rises; edge panels slide in', () => {
  motion.setMotionLevel('standard')
  const below = element()
  motion.playEnter(below, 'menu')
  assert.match(String(fake(below).last.frames[0].transform), /translate3d\(0px, -4px, 0\)/)
  const above = element()
  fake(above).dataset.motionSide = 'above'
  motion.playEnter(above, 'menu')
  assert.match(String(fake(above).last.frames[0].transform), /translate3d\(0px, 4px, 0\)/)
  const panel = element()
  motion.playEnter(panel, 'panel')
  assert.match(String(fake(panel).last.frames[0].transform), /translate3d\(12px, 0px, 0\)/)
  const popover = element()
  motion.playEnter(popover, 'popover')
  assert.doesNotMatch(String(fake(popover).last.frames[0].transform), /scale/, 'containers that host web content never scale')
})

test('interrupting continues from the visible state and only the latest request completes', () => {
  motion.setMotionLevel('standard')
  const target = element()
  motion.playEnter(target, 'dialog')
  // Close while still opening: the exit starts where the element is now.
  fake(target).computed = { opacity: '0.4', transform: 'matrix(1, 0, 0, 1, 0, 5)' }
  let closed = 0
  const abandon = motion.playExit(target, 'dialog', () => { closed += 1 })
  assert.equal(fake(target).animations[0].playState, 'idle', 'the entrance was cancelled, not stacked')
  assert.deepEqual(fake(target).last.frames[0], { opacity: 0.4, transform: 'matrix(1, 0, 0, 1, 0, 5)' })
  // Reopen while closing: the exit callback is abandoned, the entrance resumes from mid-exit.
  abandon()
  fake(target).computed = { opacity: '0.2', transform: 'matrix(1, 0, 0, 1, 0, 7)' }
  motion.playEnter(target, 'dialog')
  const exit = fake(target).animations[1]
  assert.equal(exit.playState, 'idle')
  exit.onfinish?.()
  assert.equal(closed, 0, 'a superseded exit never unmounts the reopened surface')
  assert.deepEqual(fake(target).last.frames[0], { opacity: 0.2, transform: 'matrix(1, 0, 0, 1, 0, 7)' })
  assert.equal(fake(target).animations.filter((animation) => animation.playState === 'running').length, 1)
})

test('Off mode closes synchronously and plays nothing', () => {
  motion.setMotionLevel('off')
  const target = element()
  assert.equal(motion.playEnter(target, 'menu'), null)
  let done = false
  motion.playExit(target, 'menu', () => { done = true })
  assert.equal(done, true)
  assert.equal(motion.playMove(target, 40, 0), null)
  assert.equal(fake(target).animations.length, 0)
  motion.setMotionLevel('standard')
})

test('an exit that never ticks (hidden window) still completes', async () => {
  motion.setMotionLevel('standard')
  const target = element()
  let done = false
  motion.playExit(target, 'fade', () => { done = true })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(done, true)
})

test('critical surfaces appear without an entrance but still leave with motion', () => {
  motion.setMotionLevel('standard')
  const target = element()
  fake(target).setAttribute('data-motion-immediate', '')
  assert.equal(motion.playEnter(target, 'dialog'), null)
  let done = false
  motion.playExit(target, 'dialog', () => { done = true })
  assert.equal(fake(target).animations.length, 1)
  fake(target).last.finish()
  assert.equal(done, true)
})

test('repositioning translates only, at the level\'s duration', () => {
  motion.setMotionLevel('enhanced')
  const target = element()
  motion.playMove(target, -12, 30)
  const move = fake(target).last
  assert.deepEqual(move.frames, [{ transform: 'translate3d(-12px, 30px, 0)' }, { transform: 'none' }])
  assert.equal(move.options.duration, 220)
  motion.setMotionLevel('standard')
  assert.equal(motion.repositionDuration(), 180)
  assert.equal(motion.playMove(target, 0.2, 0.3), null, 'sub-pixel changes are not animated')
})
