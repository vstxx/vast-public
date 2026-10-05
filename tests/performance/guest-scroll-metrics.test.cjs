const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const modulePath = path.join(__dirname, '../../scripts/guest-scroll-metrics.cjs')
const metrics = fs.existsSync(modulePath) ? require(modulePath) : {}

test('frame interval summary reports hand-checked percentiles without inventing missed frames', () => {
  assert.equal(typeof metrics.summarizeIntervals, 'function')
  assert.deepEqual(metrics.summarizeIntervals([0, 6, 12, 19, 25, 43], 6.06), {
    count: 5,
    p50Ms: 6,
    p95Ms: 18,
    p99Ms: 18,
    maxMs: 18
  })
})

test('trace summary never presents renderer animation frames as compositor presentation', () => {
  assert.equal(typeof metrics.summarizePresentedFrames, 'function')
  assert.equal(metrics.summarizePresentedFrames([
    { name: 'BeginMainFrame', ts: 1000 },
    { name: 'DrawFrame', ts: 7000 }
  ], 6.06), null)
})

test('trace summary uses only explicit presentation events in timestamp order', () => {
  assert.equal(typeof metrics.summarizePresentedFrames, 'function')
  assert.deepEqual(metrics.summarizePresentedFrames([
    { name: 'FramePresented', ts: 19000 },
    { name: 'BeginMainFrame', ts: 24000 },
    { name: 'FramePresented', ts: 1000 },
    { name: 'FramePresented', ts: 13000 }
  ], 6.06), {
    count: 2,
    p50Ms: 6,
    p95Ms: 12,
    p99Ms: 12,
    maxMs: 12
  })
})

test('scroll trace pairs Chromium scroll arrivals with presented frames and counts jank', () => {
  assert.equal(typeof metrics.summarizeScrollTrace, 'function')
  const events = [
    { name: 'ScrollJankV4', ph: 'b', pid: 5, id2: { local: 'ignored' }, ts: 500, args: { scroll_jank_v4: { is_janky: false, updates: { scroll_begin_arrival_us: 500 } } } },
    { name: 'ScrollJankV4', ph: 'b', pid: 5, id2: { local: 'a' }, ts: 1000, args: { scroll_jank_v4: { is_janky: false, updates: { scroll_begin_arrival_us: 1500 } } } },
    { name: 'Presentation', pid: 5, id2: { local: 'a' }, ts: 9000, cat: 'input.scrolling', args: { scroll_jank_v4: {} } },
    { name: 'ScrollJankV4', ph: 'b', pid: 5, id2: { local: 'b' }, ts: 10000, args: { scroll_jank_v4: { is_janky: true, updates: { scroll_begin_arrival_us: 10500 } } } },
    { name: 'Presentation', pid: 5, id2: { local: 'b' }, ts: 23000, cat: 'input.scrolling', args: { scroll_jank_v4: {} } },
    { name: 'ScrollJankV4', ph: 'b', pid: 5, id2: { local: 'a' }, ts: 25000, args: { scroll_jank_v4: { is_janky: false, updates: { scroll_begin_arrival_us: 25500 } } } },
    { name: 'Presentation', pid: 5, id2: { local: 'a' }, ts: 35000, cat: 'input.scrolling', args: { scroll_jank_v4: {} } },
    { name: 'Display::FrameDisplayed', pid: 6, ts: 9000 },
    { name: 'Display::FrameDisplayed', pid: 6, ts: 23000 },
    { name: 'Display::FrameDisplayed', pid: 6, ts: 35000 },
    { name: 'AnimationFrame::Presentation', pid: 6, ts: 12000 }
  ]
  assert.deepEqual(metrics.summarizeScrollTrace(events, 6.94), {
    rendererPid: 5,
    scrollUpdates: 4,
    presentedUpdates: 3,
    matchedPresentations: 3,
    gpuDisplayedPresentations: 3,
    jankyUpdates: 1,
    scrollPresentationSpacing: { count: 2, p50Ms: 12, p95Ms: 14, p99Ms: 14, maxMs: 14 },
    inputToPresentationMs: { count: 3, p50Ms: 9.5, p95Ms: 12.5, p99Ms: 12.5, maxMs: 12.5 }
  })
})

test('duration summaries preserve ordered percentiles for CDP acknowledgments', () => {
  assert.deepEqual(metrics.summarizeValues([12, 1, 5, 9]), {
    count: 4, p50Ms: 5, p95Ms: 12, p99Ms: 12, maxMs: 12
  })
})
