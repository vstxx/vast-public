import assert from 'node:assert/strict'
import test from 'node:test'
import { CatAnimationScheduler, catAmbientSceneOrder, type ActiveCatAnimation } from '../../src/shared/cat-addon-scheduler.ts'

class FakeClock {
  nowValue = 0
  randomValue = 0
  nextId = 1
  timers = new Map<number, { at: number; callback: () => void }>()

  now = (): number => this.nowValue
  random = (): number => this.randomValue
  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.timers.set(id, { at: this.nowValue + delayMs, callback })
    return id
  }
  clearTimeout = (handle: unknown): void => { this.timers.delete(Number(handle)) }

  advance(ms: number): void {
    const target = this.nowValue + ms
    while (true) {
      const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      if (!next || next[1].at > target) break
      this.nowValue = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.nowValue = target
  }
}

function scheduler(clock: FakeClock, options: { eligible?: () => boolean; changes?: Array<ActiveCatAnimation | null> } = {}): CatAnimationScheduler {
  return new CatAnimationScheduler({
    clock,
    eligible: options.eligible,
    onAnimationChanged: (animation) => options.changes?.push(animation),
    startupQuietMs: 45_000,
    globalCooldownMs: 45_000
  })
}

test('ordinary cat animations respect startup quiet time, probability, exclusivity and global cooldown', () => {
  const clock = new FakeClock()
  const changes: Array<ActiveCatAnimation | null> = []
  const subject = scheduler(clock, { changes })
  assert.equal(subject.request('omnibox-peek'), false)
  clock.advance(45_000)
  clock.randomValue = 0.9
  assert.equal(subject.request('omnibox-peek', { probability: 0.1 }), false)
  clock.randomValue = 0
  assert.equal(subject.request('omnibox-peek', { probability: 0.1 }), true)
  assert.equal(subject.request('tab-run'), false)
  clock.advance(2_400)
  assert.equal(subject.getActive(), null)
  assert.equal(subject.request('tab-run'), false)
  clock.advance(45_000)
  assert.equal(subject.request('tab-run'), true)
  assert.equal(changes.some((change) => change?.id === 'omnibox-peek'), true)
})

test('per-animation cooldown and cancellation are deterministic', () => {
  const clock = new FakeClock()
  const subject = new CatAnimationScheduler({ clock, startupQuietMs: 0, globalCooldownMs: 0 })
  assert.equal(subject.request('tab-tail'), true)
  assert.equal(subject.cancel((active) => active.id === 'tab-run'), false)
  assert.equal(subject.cancel((active) => active.id === 'tab-tail'), true)
  assert.equal(subject.request('tab-tail'), false)
  assert.equal(subject.request('tab-run'), true)
  assert.equal(subject.cancel(), true)
  clock.advance(16_000)
  assert.equal(subject.request('tab-tail'), true)
  subject.dispose()
  assert.equal(subject.getActive(), null)
  assert.equal(clock.timers.size, 0)
})

test('secret phrases bypass ordinary quiet time but deduplicate identical input', () => {
  const clock = new FakeClock()
  const subject = scheduler(clock)
  assert.equal(subject.requestSecret('meow', 'secret-meow'), true)
  clock.advance(3_600)
  assert.equal(subject.requestSecret('meow', 'secret-meow'), false)
  subject.clearSecret()
  clock.advance(1_200)
  assert.equal(subject.requestSecret('meow', 'secret-meow'), true)
})

test('a forced secret reaction replaces an ordinary reaction without leaving an empty state', () => {
  const clock = new FakeClock()
  const changes: Array<ActiveCatAnimation | null> = []
  const subject = new CatAnimationScheduler({ clock, startupQuietMs: 0, globalCooldownMs: 0, onAnimationChanged: (change) => changes.push(change) })
  assert.equal(subject.request('tab-run'), true)
  assert.equal(subject.requestSecret('vast cat', 'secret-vast-cat'), true)
  assert.equal(subject.getActive()?.id, 'secret-vast-cat')
  assert.deepEqual(changes.slice(-2).map((change) => change?.id ?? null), [null, 'secret-vast-cat'])
})

test('forced previews can restart the same scene without being swallowed by its cooldown', () => {
  const clock = new FakeClock()
  const subject = new CatAnimationScheduler({ clock, startupQuietMs: 0, globalCooldownMs: 0 })
  assert.equal(subject.request('omnibox-peek'), true)
  assert.equal(subject.request('omnibox-peek', { force: true }), true)
  assert.equal(subject.getActive()?.id, 'omnibox-peek')
})

test('hidden or otherwise ineligible windows never start and reduced motion uses a bounded duration', () => {
  const clock = new FakeClock()
  let eligible = false
  const subject = new CatAnimationScheduler({ clock, eligible: () => eligible, startupQuietMs: 0, globalCooldownMs: 0 })
  assert.equal(subject.request('idle-cat'), false)
  eligible = true
  assert.equal(subject.request('idle-cat', { reducedMotion: true }), true)
  assert.equal(subject.getActive()?.durationMs, 850)
  clock.advance(849)
  assert.equal(subject.getActive()?.id, 'idle-cat')
  clock.advance(1)
  assert.equal(subject.getActive(), null)
})

test('ordinary scheduler does not repeat the same scene consecutively when alternatives exist', () => {
  const clock = new FakeClock()
  const subject = new CatAnimationScheduler({ clock, startupQuietMs: 0, globalCooldownMs: 0 })
  assert.equal(subject.request('omnibox-peek'), true)
  clock.advance(20_000)
  assert.equal(subject.request('omnibox-peek'), false)
  assert.equal(subject.request('tab-tail'), true)
  clock.advance(20_000)
  assert.equal(subject.request('omnibox-peek'), true)
})

test('direct browser interactions bypass startup quiet time but keep a short anti-spam gap', () => {
  const clock = new FakeClock()
  const subject = new CatAnimationScheduler({
    clock,
    startupQuietMs: 45_000,
    globalCooldownMs: 14_000,
    interactionCooldownMs: 4_500
  })
  assert.equal(subject.request('new-tab-reaction', { interaction: true }), true)
  clock.advance(2_300)
  assert.equal(subject.request('closing-tab-paw', { interaction: true }), false)
  clock.advance(2_200)
  assert.equal(subject.request('closing-tab-paw', { interaction: true }), true)
})

test('ambient rotation is varied, layout-aware and exposes bookmark play only when rendered', () => {
  const vertical = catAmbientSceneOrder('vertical', false)
  const horizontal = catAmbientSceneOrder('horizontal', false)
  const horizontalWithBookmarks = catAmbientSceneOrder('horizontal', true)
  assert.equal(new Set(vertical).size, vertical.length)
  assert.equal(new Set(horizontal).size, horizontal.length)
  assert.equal(vertical[0], 'edge-zoomies')
  assert.equal(horizontal[0], 'edge-zoomies')
  assert.ok(vertical.includes('sidebar-sneak'))
  assert.ok(vertical.includes('tab-climb'))
  assert.ok(horizontal.includes('tab-nap'))
  assert.equal(horizontal.includes('bookmark-paw'), false)
  assert.ok(horizontalWithBookmarks.includes('bookmark-paw'))
  for (const id of ['toolbar-patrol', 'edge-zoomies', 'omnibox-peek'] as const) {
    assert.ok(vertical.includes(id))
    assert.ok(horizontal.includes(id))
  }
})
