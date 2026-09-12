import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
const root = resolve('resources/first-party-extensions/adblocker-for-vast')
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
if (!manifest.key) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  manifest.key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}
await mkdir(resolve(root, 'dist'), { recursive: true })
await build({ entryPoints: ['background', 'worker', 'content', 'ui'].map(name => resolve(root, `src/${name}.ts`)), outdir: resolve(root, 'dist'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome148', minify: false, legalComments: 'linked', sourcemap: false })
console.log('Built standalone Adblocker for Vast. Its code and assets are not browser build entries or extraResources.')
