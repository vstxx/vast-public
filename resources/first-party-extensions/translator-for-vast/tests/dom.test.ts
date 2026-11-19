// DOM correctness tests. Bundled and run in a real Chromium page by scripts/translator-dom-tests.cjs.
// The engine is replaced by a deterministic stand-in so structure can be asserted exactly; real
// translation quality is covered by the E2E and quality suites.

import { collectSegments, prepareSegment, segmentFragment, UNIT_ATTRIBUTE } from '../src/content/segmenter.ts'
import { Renderer } from '../src/content/renderer.ts'
import { PageTranslator } from '../src/content/page.ts'

type Engine = (fragments: string[]) => string[]
const results: Array<{ name: string; ok: boolean; error?: string; ms: number }> = []
let engine: Engine = upperCase
let calls = 0
let sentChars = ''
let delayMs = 0

// Upper-cases text and keeps every element and attribute, the way Bergamot carries tags through.
function upperCase(fragments: string[]): string[] {
  return fragments.map((html) => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).parentElement?.closest('var, code')) continue
      ;(node as Text).data = (node as Text).data.toUpperCase()
    }
    return doc.body.innerHTML
  })
}

;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'test',
    async sendMessage(message: { type: string; fragments?: string[] }) {
      if (message.type === 'content:translate') {
        calls += 1
        sentChars += message.fragments!.join('\n')
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        return { ok: true, value: { fragments: engine(message.fragments!), inferenceMs: 0 } }
      }
      if (message.type === 'content:route') return { ok: true, value: { installed: true, available: true } }
      return { ok: true, value: {} }
    }
  },
  i18n: { getUILanguage: () => 'en' }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  document.body.innerHTML = ''
  document.documentElement.lang = 'en'
  engine = upperCase
  calls = 0
  sentChars = ''
  delayMs = 0
  const started = performance.now()
  try {
    await body()
    results.push({ name, ok: true, ms: performance.now() - started })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error), ms: performance.now() - started })
  }
}

async function translatePage(page: PageTranslator, mode: 'replace' | 'bilingual' = 'replace', target = 'pl') {
  const state = await page.translate('en', target, mode)
  assert(state.status === 'translated', `page state ${state.status}: ${state.error}`)
  return state
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

await test('nested formatting reuses the page elements and their listeners', async () => {
  document.body.innerHTML = '<p id="p">Read <a id="a" href="/guide" class="x">the <b>full</b> guide</a> today.</p>'
  const link = document.getElementById('a')!
  let clicks = 0
  link.addEventListener('click', (event) => { event.preventDefault(); clicks += 1 })
  const before = document.body.innerHTML
  const page = new PageTranslator()
  await translatePage(page)
  assert(document.getElementById('p')!.textContent === 'READ THE FULL GUIDE TODAY.', document.getElementById('p')!.textContent!)
  assert(document.getElementById('a') === link && link.getAttribute('href') === '/guide' && link.className === 'x', 'link not reused')
  link.click()
  assert(clicks === 1, 'listener lost')
  page.restore()
  assert(document.body.innerHTML === before, 'restore not identical')
})

await test('hostile model output cannot add elements, attributes or handlers', async () => {
  document.body.innerHTML = '<p id="p">Click <a id="a" href="/safe">here</a> to continue.</p>'
  engine = () => ['<img src="https://evil.example/x.png" onerror="window.pwned=1"><script>window.pwned=2</script>CLICK <a data-tfv-id="0" href="javascript:window.pwned=3" onclick="window.pwned=4" style="position:fixed">HERE</a> <b data-tfv-id="99" onmouseover="x()">NOW</b><iframe src="https://evil.example"></iframe><svg><use href="https://evil.example/#a"/></svg><form action="https://evil.example"><input name="q"></form>']
  const page = new PageTranslator()
  await translatePage(page)
  const p = document.getElementById('p')!
  assert(!p.querySelector('img, script, iframe, svg, use, form, input, b'), `unexpected element: ${p.innerHTML}`)
  const link = document.getElementById('a')!
  assert(link.getAttribute('href') === '/safe' && !link.hasAttribute('onclick') && !link.hasAttribute('style'), `link attributes changed: ${link.outerHTML}`)
  assert(p.textContent!.includes('CLICK') && p.textContent!.includes('NOW'), 'text lost')
  assert(!(window as unknown as { pwned?: number }).pwned, 'script ran')
  page.restore()
})

await test('bilingual copies carry no ids or handlers and are removed on restore', async () => {
  document.body.innerHTML = '<p id="p">The quick brown fox jumps over the lazy dog near the <a id="a" href="#x" onclick="return false">river</a> bank.</p>'
  const before = document.body.innerHTML
  const page = new PageTranslator()
  await translatePage(page, 'bilingual')
  const copy = document.querySelector('tfv-translation')!
  assert(copy && copy.textContent!.includes('QUICK BROWN FOX'), 'no copy')
  assert(!copy.querySelector('[id], [onclick]'), `copy kept ids or handlers: ${copy.innerHTML}`)
  assert(document.getElementById('p')!.firstChild!.textContent === 'The quick brown fox jumps over the lazy dog near the ', 'original changed')
  page.restore()
  assert(document.body.innerHTML === before, 'restore not identical')
})

await test('form values, passwords and editors never reach the engine or change', async () => {
  document.body.innerHTML = '<label>Your name <input id="n" value="secret value"></label><p>Password <input id="pw" type="password" value="hunter2"> required here.</p><input type="hidden" name="csrf" value="token-123"><div contenteditable="true">User draft text that must stay</div><textarea>typed message body</textarea><select><option>First choice</option></select>'
  const page = new PageTranslator()
  await translatePage(page)
  for (const secret of ['secret value', 'hunter2', 'token-123', 'User draft', 'typed message']) assert(!sentChars.includes(secret), `${secret} was sent`)
  assert((document.getElementById('n') as HTMLInputElement).value === 'secret value' && (document.getElementById('pw') as HTMLInputElement).value === 'hunter2', 'values changed')
  assert(document.querySelector('[contenteditable]')!.textContent === 'User draft text that must stay', 'editor translated')
  assert(document.body.textContent!.includes('YOUR NAME') && document.body.textContent!.includes('REQUIRED HERE'), 'labels not translated')
  page.restore()
})

await test('a field the engine drops falls back to a copy and the live field stays', async () => {
  document.body.innerHTML = '<p id="p">Enter the code <input id="code" value="42"> to continue with the payment.</p>'
  engine = () => ['ENTER THE CODE TO CONTINUE WITH THE PAYMENT.']
  const input = document.getElementById('code')
  const page = new PageTranslator()
  await translatePage(page)
  assert(document.getElementById('code') === input && input!.isConnected, 'field removed')
  assert(document.querySelector('tfv-translation'), 'no fallback copy')
  page.restore()
})

await test('protected content, code and urls survive exactly', async () => {
  document.body.innerHTML = '<p id="p">Visit https://example.com/a?b=1 or run <code>npm test</code> with <span class="notranslate">BrandName</span> version 2026-10-28.</p><p translate="no" id="no">Do not translate this</p>'
  const page = new PageTranslator()
  await translatePage(page)
  const text = document.getElementById('p')!.textContent!
  for (const kept of ['https://example.com/a?b=1', 'npm test', 'BrandName', '2026-10-28']) assert(text.includes(kept), `${kept} changed: ${text}`)
  assert(document.getElementById('no')!.textContent === 'Do not translate this', 'translate=no translated')
  page.restore()
})

await test('tables, lists and attributes translate and restore', async () => {
  document.body.innerHTML = '<table><tr><th title="Column of days">Day</th><td>Sunny afternoon</td></tr></table><ul><li>First item</li><li>Second item</li></ul><input id="q" placeholder="Search the archive"><img id="img" alt="A red bicycle" src="data:,">'
  const before = document.body.innerHTML
  const page = new PageTranslator()
  await translatePage(page)
  assert(document.querySelector('td')!.textContent === 'SUNNY AFTERNOON' && document.querySelectorAll('li')[1]!.textContent === 'SECOND ITEM', 'cells or items not translated')
  assert(document.querySelector('th')!.getAttribute('title') === 'COLUMN OF DAYS', 'title not translated')
  assert(document.getElementById('q')!.getAttribute('placeholder') === 'SEARCH THE ARCHIVE' && document.getElementById('img')!.getAttribute('alt') === 'A RED BICYCLE', 'attributes not translated')
  page.restore()
  assert(document.body.innerHTML === before, 'restore not identical')
})

await test('right-to-left targets are labelled', async () => {
  document.body.innerHTML = '<p id="p">Hello there friends</p>'
  const page = new PageTranslator()
  await translatePage(page, 'replace', 'ar')
  assert(document.getElementById('p')!.getAttribute('dir') === 'rtl' && document.getElementById('p')!.getAttribute('lang') === 'ar', 'not labelled rtl')
  page.restore()
  assert(!document.getElementById('p')!.hasAttribute('dir'), 'dir left behind')
})

await test('dynamic additions are translated once and own output is never re-sent', async () => {
  document.body.innerHTML = '<main id="m"><p id="a">First message from the team</p></main>'
  const page = new PageTranslator()
  await translatePage(page)
  const before = calls
  const p = document.createElement('p')
  p.textContent = 'A later message arrived'
  document.getElementById('m')!.append(p)
  await settle()
  assert(p.textContent === 'A LATER MESSAGE ARRIVED', `added node not translated: ${p.textContent}`)
  const afterAdd = calls
  assert(afterAdd === before + 1, `expected one engine call, got ${afterAdd - before}`)
  // A framework re-rendering the translated text itself must not trigger translation of our output.
  document.getElementById('a')!.textContent = 'FIRST MESSAGE FROM THE TEAM'
  await settle()
  assert(calls === afterAdd, 'own output was sent back to the engine')
  // New source text in a translated block is translated again.
  document.getElementById('a')!.textContent = 'Completely different news today'
  await settle()
  assert(document.getElementById('a')!.textContent === 'COMPLETELY DIFFERENT NEWS TODAY', 'rewritten block not retranslated')
  assert(document.querySelectorAll('tfv-translation').length === 0, 'duplicates')
  page.restore()
})

await test('a large SPA insertion is processed with bounded ancestor checks', async () => {
  document.body.innerHTML = '<main id="feed"><p>Original feed heading</p></main>'
  const page = new PageTranslator()
  await translatePage(page)
  const feed = document.getElementById('feed')!
  const originalContains = Node.prototype.contains
  let containsCalls = 0
  Node.prototype.contains = function (other) {
    containsCalls += 1
    return originalContains.call(this, other)
  }
  try {
    const nodes = Array.from({ length: 600 }, (_, index) => {
      const p = document.createElement('p')
      p.textContent = `New account listing number ${index} from the market`
      return p
    })
    feed.append(...nodes)
    for (let attempt = 0; attempt < 60 && !nodes.every((node) => node.textContent?.startsWith('NEW ACCOUNT')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(nodes.every((node) => node.textContent?.startsWith('NEW ACCOUNT')), 'feed was not translated')
    assert(containsCalls < 6_000, `ancestor checks grew with the square of insertions: ${containsCalls}`)
  } finally {
    Node.prototype.contains = originalContains
    page.restore()
  }
})

await test('continuous SPA churn is throttled and eventually caught up', async () => {
  document.body.innerHTML = '<main id="feed"><p>Original feed heading</p></main>'
  const page = new PageTranslator()
  await translatePage(page)
  try {
    const before = calls
    const nodes: HTMLElement[] = []
    for (let index = 0; index < 10; index += 1) {
      const node = document.createElement('p')
      node.textContent = `New feed item number ${index} arrived today`
      nodes.push(node)
      document.getElementById('feed')!.append(node)
      await new Promise((resolve) => setTimeout(resolve, 320))
    }
    assert(calls - before <= 8, `too many observer translations in one burst: ${calls - before}`)
    for (let attempt = 0; attempt < 40 && !nodes.every((node) => node.textContent?.startsWith('NEW FEED')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(nodes.every((node) => node.textContent?.startsWith('NEW FEED')), 'throttled changes were lost')
  } finally {
    page.restore()
  }
})

await test('a mutation arriving during a slow follow-up is not lost', async () => {
  document.body.innerHTML = '<main id="feed"><p>Original feed heading</p></main>'
  const page = new PageTranslator()
  await translatePage(page)
  try {
    delayMs = 500
    const first = document.createElement('p')
    first.textContent = 'First later message from the market'
    document.getElementById('feed')!.append(first)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = document.createElement('p')
    second.textContent = 'Second later message from the market'
    document.getElementById('feed')!.append(second)
    for (let attempt = 0; attempt < 25 && second.textContent !== 'SECOND LATER MESSAGE FROM THE MARKET'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(first.textContent === 'FIRST LATER MESSAGE FROM THE MARKET', 'first mutation was not translated')
    assert(second.textContent === 'SECOND LATER MESSAGE FROM THE MARKET', 'mutation during translation was lost')
  } finally {
    page.restore()
  }
})

await test('restore during translation leaves the page identical', async () => {
  document.body.innerHTML = Array.from({ length: 120 }, (_, index) => `<p>Paragraph number ${index} with some ordinary words in it.</p>`).join('')
  const before = document.body.innerHTML
  delayMs = 20
  const page = new PageTranslator()
  const running = page.translate('en', 'pl', 'replace')
  await new Promise((resolve) => setTimeout(resolve, 60))
  page.restore()
  await running
  await settle()
  assert(document.body.innerHTML === before, 'partial translation left traces')
  assert(!document.querySelector(`[${UNIT_ATTRIBUTE}]`), 'markers left')
})

await test('repeated translate and restore cycles are stable', async () => {
  document.body.innerHTML = '<h1>News of the day</h1><p>One <i>small</i> step for a <a href="#m">man</a>.</p><div><span>Inline text in a div</span></div>'
  const before = document.body.innerHTML
  const page = new PageTranslator()
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await translatePage(page, cycle % 2 ? 'bilingual' : 'replace')
    page.restore()
    assert(document.body.innerHTML === before, `cycle ${cycle} differs`)
  }
})

await test('open shadow roots are translated', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  host.attachShadow({ mode: 'open' }).innerHTML = '<p>Text inside a component</p>'
  const page = new PageTranslator()
  await translatePage(page)
  assert(host.shadowRoot!.textContent === 'TEXT INSIDE A COMPONENT', 'shadow content not translated')
  page.restore()
})

await test('page edits after translation are kept on restore', async () => {
  document.body.innerHTML = '<p id="p">Total items in the basket: <span id="n">3</span> right now</p>'
  const page = new PageTranslator()
  await translatePage(page)
  document.getElementById('n')!.textContent = '4'
  await settle()
  page.restore()
  assert(document.getElementById('n')!.textContent === '4', 'page edit undone')
  assert(document.getElementById('p')!.textContent!.startsWith('Total items'), 'not restored')
})

await test('segmentation of a long page stays bounded', async () => {
  document.body.innerHTML = Array.from({ length: 3000 }, (_, index) => `<article><h2>Heading ${index}</h2><p>Body text <a href="#${index}">link</a> and <b>bold</b> words number ${index}.</p></article>`).join('')
  const started = performance.now()
  const segments = collectSegments(document.body, { skipFormFields: true })
  const ms = performance.now() - started
  assert(segments.length === 6000, `segments ${segments.length}`)
  // The longest single batch preparation is what the page feels.
  let longestBatch = 0
  for (let index = 0; index < segments.length; index += 24) {
    const batchStarted = performance.now()
    for (const segment of segments.slice(index, index + 24)) prepareSegment(segment)
    longestBatch = Math.max(longestBatch, performance.now() - batchStarted)
  }
  assert(segments.every((segment) => segmentFragment(segment).length < 400), 'fragment too large')
  ;(results as unknown as { segmentationMs?: number }).segmentationMs = ms
  ;(results as unknown as { batchMs?: number }).batchMs = longestBatch
  assert(ms < 1500, `segmentation took ${ms} ms`)
})

await test('renderer escapes text from plain segments', () => {
  document.body.innerHTML = '<p>Text <b>bold</b></p>'
  const renderer = new Renderer()
  const [segment] = collectSegments(document.body, { skipFormFields: true })
  prepareSegment(segment!)
  renderer.markPending(segment!)
  renderer.apply(segment!, '&lt;img src=x onerror=alert(1)&gt; <b data-tfv-id="0">BOLD</b>', { displayMode: 'replace', targetLanguage: 'pl' })
  assert(!document.querySelector('img') && document.querySelector('p')!.textContent === '<img src=x onerror=alert(1)> BOLD', document.body.innerHTML)
})

;(window as unknown as { __results: unknown }).__results = { results, segmentationMs: (results as unknown as { segmentationMs?: number }).segmentationMs, batchMs: (results as unknown as { batchMs?: number }).batchMs }
