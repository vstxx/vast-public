import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const brandMarkSource = readFileSync(new URL('../../src/renderer/components/ui/BrandMark.tsx', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const prepareReleaseSource = readFileSync(new URL('../../scripts/prepare-release.ps1', import.meta.url), 'utf8')

test('public beta is packaged as one Vast 0.2.5 product', () => {
  assert.equal(packageJson.version, '0.2.5')
  assert.equal(packageJson.build.productName, 'Vast')
  assert.match(packageJson.scripts['dist:upgrader'], /build-release\.cjs upgrader/)
  assert.match(packageJson.scripts['dist:public'], /dist:upgrader/)
  assert.match(packageJson.scripts['release:stable'], /dist:upgrader/)
  assert.match(packageJson.scripts['release:windows'], /dist:upgrader/)
  assert.match(packageJson.scripts['release:version-check'], /release-version-consistency/)
  assert.equal(packageJson.scripts['build:free'], undefined)
  assert.equal(packageJson.scripts['dist:free'], undefined)
})

test('release generator omits edition metadata from new manifests', () => {
  assert.doesNotMatch(prepareReleaseSource, /\bedition\s*=\s*\$Edition/)
  assert.doesNotMatch(prepareReleaseSource, /\btargetEdition\s*=\s*\$Edition/)
  assert.match(prepareReleaseSource, /releases\/download\/v\$Version\//)
})

test('Windows package and runtime window use the dedicated Vast app icon', () => {
  assert.equal(packageJson.build.icon, 'assets/logos/vasticon.png')
  assert.equal(packageJson.build.win.icon, 'assets/logos/vasticon-windows.png')
  assert.equal(packageJson.author, 'VastProductions')
  assert.deepEqual(packageJson.build.win.signtoolOptions.publisherName, ['VastProductions'])
  assert.equal(packageJson.build.mac.icon, 'assets/logos/vasticon.png')
  assert.equal(packageJson.build.linux.icon, 'assets/logos/vasticon.png')
  assert.ok(
    packageJson.build.extraResources.some(
      (resource: { from?: string; to?: string }) =>
        resource.from === 'assets/logos/vasticon.png' && resource.to === 'app-icon.png'
    )
  )
  assert.ok(
    packageJson.build.extraResources.some(
      (resource: { from?: string; to?: string }) =>
        resource.from === 'assets/logos/vasticon-windows.png' && resource.to === 'app-icon-windows.png'
    )
  )
  assert.equal(packageJson.build.win.signAndEditExecutable, true)
  assert.equal(packageJson.build.win.signExecutable, true)
  assert.equal(packageJson.build.forceCodeSigning, true)
  assert.equal(packageJson.build.afterPack, 'scripts/after-pack-hardening.cjs')
  assert.match(windowSource, /APP_ICON_PATH/)
  assert.match(windowSource, /assets\/logos\/vasticon\.png/)
  assert.match(windowSource, /assets\/logos\/vasticon-windows\.png/)
  assert.match(windowSource, /app-icon-windows\.png/)
  assert.match(windowSource, /icon:\s*APP_ICON_PATH/)
  assert.match(brandMarkSource, /assets\/logos\/vasticon\.png/)
  assert.match(brandMarkSource, /assets\/logos\/vast\.png/)
  assert.doesNotMatch(brandMarkSource, />Vast<\/div>/)
})

test('opening startup intent is captured before the React root without prematurely starting its timeline', () => {
  const timelineIndex = indexHtml.indexOf('__vastOpeningStartupEnabled')
  const rootIndex = indexHtml.indexOf('id="root"')
  assert.ok(timelineIndex > -1)
  assert.ok(rootIndex > timelineIndex)
  assert.doesNotMatch(indexHtml, /__vastOpeningStartedAt/)
  assert.doesNotMatch(indexHtml, /vast-static-opening/)
})
