import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const root = resolve('resources/first-party-extensions/adblocker-for-vast')
execFileSync(process.execPath, [resolve(root, 'assets/source/compile-adblock-resources.mjs'), '--check'], { stdio: 'inherit' })
for (const file of JSON.parse(await readFile(resolve(root, 'assets/provenance.json'), 'utf8')).files) {
  const bytes = await readFile(resolve(root, 'assets', file.name))
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Asset provenance mismatch: ${file.name}. Restore the reviewed upstream bytes, including LF line endings.`)
}
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
const identity = createHash('sha256').update(Buffer.from(manifest.key ?? '', 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))
if (identity !== 'ighghepofocdonohadbmkbgmphppdagk') throw new Error('The stable Adblocker manifest key is missing or changed. Restore it; never generate a replacement.')
await mkdir(resolve(root, 'dist'), { recursive: true })
await build({ entryPoints: ['background', 'worker', 'content', 'ui'].map(name => resolve(root, `src/${name}.ts`)), outdir: resolve(root, 'dist'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome148', minify: false, legalComments: 'linked', sourcemap: false })
console.log('Built standalone Adblocker for Vast. Its code and assets are not browser build entries or extraResources.')
