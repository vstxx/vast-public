const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
// Exact structural exceptions; ordinary controls must use semantic tokens.
const structural = new Map([
  ['.vast-logo-aura::before', '50%'],
  ['.vast-opening-logo-halo', '50%'],
  ['.vast-geometry-circle', '50%'],
  ['.vast-opening-overlay', '0'],
  ['.side-panel-slot.is-docked .side-panel', '0'],
  ['html.vast-pdf-printing .pdf-print-preview-overlay > div', '0 !important']
])
function radiusViolations(text, file = 'fixture.css') {
    const failures = []
    const report = (index, value) => failures.push(`${path.relative(root, file)}:${text.slice(0, index).split('\n').length}: ${value}`)
    for (const match of text.matchAll(/\brounded-(?:[a-z0-9-]+|(?:[a-z]+-)?\[[^\]]+\])(?=[\s'"`.,}])/g)) {
      if (!/^rounded-(micro|checkbox|swatch|control|card|panel|modal)$/.test(match[0])) report(match.index, match[0])
    }
    for (const match of text.matchAll(/border(?:-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end)))?-radius\s*:\s*([^;}'"]+)/g)) {
      const value = match[1].trim()
      if (value.includes('var(--vast-') || value === 'inherit') continue
      const before = text.slice(0, match.index)
      const brace = before.lastIndexOf('{')
      const selector = before.slice(Math.max(before.lastIndexOf('}', brace), before.lastIndexOf('{', brace - 1)) + 1, brace).replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (structural.get(selector) !== value) report(match.index, `${selector}: ${value}`)
    }
    for (const match of text.matchAll(/\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight|StartStart|StartEnd|EndStart|EndEnd)?Radius\s*:\s*([^,}\n]+)/g)) {
      if (!match[1].includes('var(--vast-')) report(match.index, match[0])
    }
    for (const match of text.matchAll(/--[\w-]*radius[\w-]*:\s*([^;]+);/g)) {
      if (match[0] === '--vast-radius-base: 26px;' || match[1].includes('var(--vast-')) continue
      report(match.index, match[0])
    }
    for (const match of text.matchAll(/className\s*=\s*(?:{\s*)?["'`]([^"'`]+)["'`]/g)) {
      if (/(?:^|\s)rounded(?:\s|$)/.test(match[1])) report(match.index, 'rounded')
    }
    return failures
}
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : /\.(tsx?|css|html)$/.test(entry.name) ? radiusViolations(fs.readFileSync(file,'utf8'),file) : []
  })
}
module.exports = { radiusViolations }
if (require.main === module) {
  const failures = [...walk(path.join(root, 'src')), ...radiusViolations(fs.readFileSync(path.join(root,'index.html'),'utf8'),'index.html')]
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
  else console.log('Radius guard passed: semantic radii only.')
}
