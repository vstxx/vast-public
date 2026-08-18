const { readdirSync, statSync } = require('node:fs')
const { basename, join } = require('node:path')

const root = join(__dirname, '..', 'out')
const limits = {
  initialRendererBytes: 1_400_000,
  mainEntryBytes: 500_000,
  preloadEntryBytes: 24_000,
  totalJavaScriptBytes: 6_800_000
}

function filesUnder(dir, result = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) filesUnder(path, result)
    else if (/\.(js|cjs|mjs)$/.test(entry)) result.push({ path, name: basename(path), bytes: stats.size })
  }
  return result
}

const files = filesUnder(root)
const initialRenderer = files.find((file) => /^index-[\w-]+\.js$/.test(file.name))
const mainEntry = files.find((file) => file.path.includes(`${join('out', 'main')}`) && file.name === 'main.js')
const preloadEntry = files.find((file) => file.path.includes(`${join('out', 'preload')}`) && file.name === 'index.js')
const actual = {
  initialRendererBytes: initialRenderer?.bytes ?? Number.POSITIVE_INFINITY,
  mainEntryBytes: mainEntry?.bytes ?? Number.POSITIVE_INFINITY,
  preloadEntryBytes: preloadEntry?.bytes ?? Number.POSITIVE_INFINITY,
  totalJavaScriptBytes: files.reduce((sum, file) => sum + file.bytes, 0)
}

const failures = Object.entries(limits).filter(([key, limit]) => actual[key] > limit)
console.log(JSON.stringify({ limits, actual }, null, 2))
if (failures.length) {
  console.error(`Performance budget exceeded: ${failures.map(([key]) => key).join(', ')}`)
  process.exitCode = 1
}
