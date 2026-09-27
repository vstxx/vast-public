import { querySelectorAll, matches, handlePseudoDirective, type AST } from '@ghostery/adblocker-extended-selectors'
import type { IMessageFromBackground } from '@ghostery/adblocker-content'
type Rule = IMessageFromBackground['extended'][number]
// Use the engine's parsed AST, never a second selector parser. An ancestor
// matching the left-hand CSS anchor is the smallest useful query boundary.
function anchor(ast: AST): string | undefined {
  if (['id', 'class', 'type', 'attribute'].includes(ast.type)) return (ast as { content: string }).content
  if (ast.type === 'complex') return ast.left && anchor(ast.left)
  if (ast.type === 'compound') return ast.compound.map(anchor).find(Boolean)
}
export function proceduralFiltering() {
  const rules = new Map<number, Rule>(), marked = new Map<number, Set<Element>>()
  const pending = new Set<Element>()
  let timer: number | undefined, dead = false, running = false
  function schedule() {
    if (!dead && !running && pending.size && timer === undefined) timer = window.setTimeout(() => void run(), 200)
  }
  function release() {
    for (const [id, elements] of marked) {
      const attribute = rules.get(id)?.attribute
      if (attribute) for (const element of elements) element.removeAttribute(attribute)
    }
    marked.clear()
  }
  async function run() {
    timer = undefined
    running = true
    const changes = [...pending]; pending.clear()
    let slice = performance.now()
    for (const rule of rules.values()) {
      if (dead) return
      const roots = new Set<Element>(), css = anchor(rule.ast)
      for (const changed of changes) {
        if (!changed.isConnected) continue
        const ancestor = css ? changed.closest(css) : undefined
        roots.add(ancestor?.parentElement ?? changed)
      }
      const found = new Set<Element>(), previous = marked.get(rule.id) ?? new Set<Element>()
      try {
        for (const root of roots) {
          if (matches(root, rule.ast)) found.add(root)
          for (const element of querySelectorAll(root, rule.ast)) found.add(element)
        }
        for (const element of previous) {
          if (!element.isConnected || [...roots].some(root => root.contains(element)) && !found.has(element)) {
            previous.delete(element)
            if (rule.attribute && ![...marked].some(([id, nodes]) => id !== rule.id && rules.get(id)?.attribute === rule.attribute && nodes.has(element))) element.removeAttribute(rule.attribute)
          }
        }
        for (const element of found) {
          if (!previous.has(element) && previous.size >= 20_000) break
          if (rule.attribute && !element.hasAttribute(rule.attribute)) element.setAttribute(rule.attribute, '')
          if (rule.directive && !previous.has(element)) handlePseudoDirective(element, rule.directive)
          if (previous.size < 20_000) previous.add(element)
        }
        marked.set(rule.id, previous)
      } catch { /* Invalid DOM/CSS in one rule must not stop other rules. */ }
      // Yield between selectors; no page-sized polling loop.
      if (performance.now() - slice > 6) { await new Promise(resolve => setTimeout(resolve, 0)); slice = performance.now() }
    }
    running = false
    schedule()
  }
  return {
    add(next: Rule[]) {
      for (const rule of next) if (!rules.has(rule.id) && rules.size < 512) { rules.set(rule.id, rule); pending.add(document.documentElement) }
      this.changed([])
    },
    changed(elements: Element[]) {
      if (dead || !rules.size) return
      for (const element of elements) if (pending.size < 512) pending.add(element)
      schedule()
    },
    stop() { dead = true; clearTimeout(timer); pending.clear(); release(); rules.clear() }
  }
}
