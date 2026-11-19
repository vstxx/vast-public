// Builds the installable extension into dist/. Offline and deterministic: it verifies the pinned
// engine files and the packaged catalog, bundles the TypeScript sources, and copies assets. It
// never downloads anything; run tools/fetch-engine.mjs once to place the pinned engine binary.
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'dist')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const lock = JSON.parse(await readFile(resolve(root, 'vendor/bergamot/engine.lock.json'), 'utf8'))
const glue = await readFile(resolve(root, 'vendor/bergamot', lock.glue.file))
if (sha256(glue) !== lock.glue.sha256 || !glue.toString('utf8').includes(`BERGAMOT_VERSION_FULL = "${lock.glue.versionString}"`)) {
  throw new Error('vendor/bergamot glue does not match engine.lock.json. Restore the pinned file (LF line endings).')
}
let wasm
try {
  wasm = await readFile(resolve(root, 'vendor/bergamot', lock.wasm.file))
} catch {
  throw new Error('The engine binary is missing. Run: node resources/first-party-extensions/translator-for-vast/tools/fetch-engine.mjs')
}
if (wasm.length !== lock.wasm.bytes || sha256(wasm) !== lock.wasm.sha256) throw new Error('The engine binary does not match engine.lock.json.')
const license = await readFile(resolve(root, 'vendor/bergamot', lock.license.file))
if (sha256(license) !== lock.license.sha256) throw new Error('The engine license text does not match engine.lock.json.')

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
const identity = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
if (identity !== 'oaamgecaoemplhkceohcpahaeampndpj') throw new Error('The stable Translator manifest key is missing or changed. Restore it; never generate a replacement.')

await rm(out, { recursive: true, force: true })
await mkdir(resolve(out, 'icons'), { recursive: true })
await mkdir(resolve(out, 'catalog'), { recursive: true })
await mkdir(resolve(out, 'licenses'), { recursive: true })

const entries = {
  background: 'src/background/background.ts',
  offscreen: 'src/engine/offscreen.ts',
  'engine-worker': 'src/engine/worker.ts',
  content: 'src/content/content.ts',
  auto: 'src/content/auto.ts',
  'selection-button': 'src/content/selection-button.ts',
  popup: 'src/ui/popup.ts',
  options: 'src/ui/options.ts'
}
await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, resolve(root, path)])),
  outdir: out,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  minify: false,
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
  logLevel: 'warning'
})

const copies = [
  ['vendor/bergamot/bergamot-translator.js', 'bergamot-translator.js'],
  ['vendor/bergamot/bergamot-translator.wasm', 'bergamot-translator.wasm'],
  ['catalog/models.json', 'catalog/models.json'],
  ['src/engine/offscreen.html', 'offscreen.html'],
  ['src/ui/popup.html', 'popup.html'],
  ['src/ui/options.html', 'options.html'],
  ['src/ui/ui.css', 'ui.css'],
  ['src/content/content.css', 'content.css'],
  ['assets/icons/icon-16.png', 'icons/icon-16.png'],
  ['assets/icons/icon-32.png', 'icons/icon-32.png'],
  ['assets/icons/icon-48.png', 'icons/icon-48.png'],
  ['assets/icons/icon-128.png', 'icons/icon-128.png'],
  ['assets/icons/toolbar.svg', 'icons/toolbar.svg'],
  ['assets/THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt'],
  ['assets/licenses/Glossa-MIT.txt', 'licenses/Glossa-MIT.txt'],
  ['assets/licenses/MPL-2.0.txt', 'licenses/MPL-2.0.txt'],
  ['LICENSE.txt', 'LICENSE.txt']
]
for (const [from, to] of copies) await copyFile(resolve(root, from), resolve(out, to))
await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Built Translator for Vast ${manifest.version} into ${out}`)
