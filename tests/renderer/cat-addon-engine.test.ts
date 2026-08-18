import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { catScaleForDpi, parseCatAnimationMetadata, snapCatCoordinate } from '../../src/shared/cat-addon-runtime.ts'
import {
  CatActor,
  CatAnimator,
  CatSceneDirector,
  CatSpriteAtlas,
  type CatEngineClock,
  type CatFrameSnapshot
} from '../../src/renderer/components/cat-addon/cat-engine.ts'

class FakeClock implements CatEngineClock {
  value = 0
  nextId = 1
  timers = new Map<number, { at: number; callback: () => void }>()
  now = (): number => this.value
  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.timers.set(id, { at: this.value + delayMs, callback })
    return id
  }
  clearTimeout = (handle: unknown): void => { this.timers.delete(Number(handle)) }
  advance(ms: number): void {
    const target = this.value + ms
    while (true) {
      const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      if (!next || next[1].at > target) break
      this.value = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.value = target
  }
}

const metadata = parseCatAnimationMetadata(JSON.parse(readFileSync('assets/cat-addon/package/animations/animations.json', 'utf8')))
const atlas = new CatSpriteAtlas(metadata)

test('CatAnimator honors exact per-frame timing and once completion', async () => {
  const clock = new FakeClock()
  const frames: CatFrameSnapshot[] = []
  const animator = new CatAnimator(atlas, (frame) => frames.push(frame), clock)
  const completed = animator.play('idle_1')
  assert.deepEqual(frames.map((frame) => frame.sourceFrame), [0])
  clock.advance(99)
  assert.equal(frames.length, 1)
  clock.advance(1)
  assert.deepEqual(frames.map((frame) => frame.sourceFrame), [0, 1])
  clock.advance(300)
  assert.equal(await completed, 'completed')
  assert.deepEqual(frames.map((frame) => frame.sourceFrame), [0, 1, 2, 3])
  assert.equal(clock.timers.size, 0)
})

test('CatAnimator supports repeat cycles, reverse playback and immediate cancellation', async () => {
  const clock = new FakeClock()
  const frames: CatFrameSnapshot[] = []
  const animator = new CatAnimator(atlas, (frame) => frames.push(frame), clock)
  const repeated = animator.play('idle_1', { cycles: 2 })
  clock.advance(800)
  assert.equal(await repeated, 'completed')
  assert.equal(frames.length, 8)
  const reversed = animator.play('idle_1', { reverse: true })
  assert.equal(frames.at(-1)?.sourceFrame, 3)
  assert.equal(animator.cancel(), true)
  assert.equal(await reversed, 'cancelled')
  assert.equal(clock.timers.size, 0)
})

test('hidden animators pause remaining frame time and do not arm timers while invisible', () => {
  const clock = new FakeClock()
  const frames: CatFrameSnapshot[] = []
  const animator = new CatAnimator(atlas, (frame) => frames.push(frame), clock)
  animator.setVisible(false)
  void animator.play('walk', { cycles: 2 })
  assert.equal(clock.timers.size, 0)
  clock.advance(500)
  assert.equal(frames.length, 1)
  animator.setVisible(true)
  clock.advance(40)
  animator.setVisible(false)
  clock.advance(900)
  assert.equal(frames.length, 1)
  animator.setVisible(true)
  clock.advance(59)
  assert.equal(frames.length, 1)
  clock.advance(1)
  assert.equal(frames.length, 2)
  animator.destroy()
  assert.equal(clock.timers.size, 0)
})

test('CatActor keeps baseline stable while compositor movement is independent', async () => {
  const clock = new FakeClock()
  const snapshots: ReturnType<CatActor['getSnapshot']>[] = []
  const actor = new CatActor(atlas, { animation: 'walk', x: 10, y: 20 }, (snapshot) => snapshots.push(snapshot), clock)
  const movement = actor.moveTo(110, 20, 600)
  const animation = actor.play('walk', { cycles: 1 })
  assert.equal(actor.getSnapshot().transitionMs, 600)
  clock.advance(600)
  assert.equal(await movement, 'completed')
  clock.advance(200)
  assert.equal(await animation, 'completed')
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.baselineY)).size, 1)
  assert.equal(actor.getSnapshot().y, 20)
  actor.destroy()
  assert.equal(clock.timers.size, 0)
})

test('CatSceneDirector sequences actions and cancellation releases every callback', async () => {
  const clock = new FakeClock()
  const actor = new CatActor(atlas, { animation: 'idle_1', x: 0, y: 0, visible: false }, () => undefined, clock)
  const director = new CatSceneDirector(actor, clock)
  const scene = director.run([
    { type: 'show', x: 12, y: 18 },
    { type: 'play', animation: 'sit_tilt' },
    { type: 'wait', durationMs: 500 },
    { type: 'hide' }
  ])
  assert.equal(actor.getSnapshot().visible, true)
  clock.advance(400)
  await Promise.resolve()
  assert.equal(clock.timers.size, 1)
  director.cancel()
  assert.equal(await scene, 'cancelled')
  assert.equal(clock.timers.size, 0)
  director.destroy()
  actor.destroy()
})

test('common Windows DPI factors resolve to integer physical backing scales and snapped positions', () => {
  for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
    const cssScale = catScaleForDpi(dpr, 2)
    assert.equal(Number.isInteger(cssScale * dpr), true, `${dpr} DPR`)
    assert.equal(Number.isInteger(snapCatCoordinate(17.37, dpr) * dpr), true, `${dpr} DPR snapping`)
  }
})
