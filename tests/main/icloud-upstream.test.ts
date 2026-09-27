import assert from 'node:assert/strict'
import test from 'node:test'
import { ICloudUpstreamClient, parseVerifiedICloudCrx } from '../../src/main/extensions/icloud-upstream.ts'

const ID = 'pejdijmoenmkgeppbflobdenhhabjlaj'

test('iCloud upstream install is pinned to the Apple extension ID and approved download hosts', async () => {
  const requests: string[] = []
  const client = new ICloudUpstreamClient(async (input) => {
    requests.push(String(input))
    return new Response(`<?xml version="1.0"?><gupdate><app appid="${ID}" status="ok"><updatecheck codebase="https://attacker.example/icloud.crx" hash_sha256="${'a'.repeat(64)}" status="ok" version="3.3.0"/></app></gupdate>`, {
      status: 200,
      headers: { 'content-type': 'text/xml' }
    })
  })
  await assert.rejects(client.latest(), /unsafe package URL/)
  assert.equal(requests.length, 1)
  const update = new URL(requests[0])
  assert.equal(update.origin, 'https://clients2.google.com')
  assert.equal(update.searchParams.get('x'), `id=${ID}&uc`)
})

test('iCloud upstream install rejects wrong update identities and non-CRX3 payloads', async () => {
  const wrongIdentity = new ICloudUpstreamClient(async () => new Response('<gupdate><app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><updatecheck status="noupdate"/></app></gupdate>', { status: 200 }))
  await assert.rejects(wrongIdentity.latest(), /wrong extension/)
  assert.throws(() => parseVerifiedICloudCrx(new Uint8Array(32)), /CRX3/)
})

test('iCloud upstream update ignores versions that are not newer', async () => {
  let requests = 0
  const client = new ICloudUpstreamClient(async () => {
    requests += 1
    if (requests > 1) throw new Error('An older upstream package must not be downloaded.')
    return new Response(`<?xml version="1.0"?><gupdate><app appid="${ID}" status="ok"><updatecheck codebase="https://clients2.google.com/icloud.crx" hash_sha256="${'a'.repeat(64)}" status="ok" version="3.3.0"/></app></gupdate>`, { status: 200 })
  })
  assert.equal(await client.latest('3.4.0'), undefined)
  assert.equal(requests, 1)
})
