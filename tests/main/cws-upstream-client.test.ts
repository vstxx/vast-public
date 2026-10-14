import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { CwsUpstreamClient } from '../../src/main/extensions/cws-upstream-client.ts'

const id = 'nckhacbgboonmhekihinhokldoogagoh'
const packageBytes = Buffer.from('not a CRX3 archive')
const hash = createHash('sha256').update(packageBytes).digest('hex')

function xml(check: string, appId = id): string {
  return `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><daystart elapsed_days="1"/><app appid="${appId}" status="ok">${check}</app></gupdate>`
}

function client(metadata: string, requests: Array<{ url: string; options: RequestInit }>, body: Uint8Array = packageBytes): CwsUpstreamClient {
  return new CwsUpstreamClient((async (url: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(url), options: options ?? {} })
    return requests.length === 1
      ? new Response(metadata, { status: 200, headers: { 'content-type': 'text/xml' } })
      : new Response(Buffer.from(body), { status: 200, headers: { 'content-type': 'application/x-chrome-extension' } })
  }) as typeof fetch)
}

test('parses real update-service structure and fails on an unsigned package', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = []
  const metadata = xml(`<updatecheck status="ok" codebase="https://clients2.googleusercontent.com/crx/test.crx" version="1.2.3.4" hash_sha256="${hash}"/>`)
  await assert.rejects(client(metadata, requests).latest(id), /CRX3/)
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.options.credentials, 'omit')
    assert.equal(request.options.redirect, 'error')
  }
})

test('rejects an unexpected app, unsafe package origin and XML declarations', async () => {
  const check = `<updatecheck status="ok" codebase="https://clients2.googleusercontent.com/crx/test.crx" version="1.2.3" hash_sha256="${hash}"/>`
  for (const metadata of [
    xml(check, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    xml(check.replace('clients2.googleusercontent.com', 'example.com')),
    `<!DOCTYPE gupdate [<!ENTITY x SYSTEM "file:///secrets">]>${xml(check)}`
  ]) {
    const requests: Array<{ url: string; options: RequestInit }> = []
    await assert.rejects(client(metadata, requests).latest(id))
    assert.equal(requests.length, 1)
  }
})

test('noupdate never downloads a package', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = []
  const result = await client(xml('<updatecheck status="noupdate"/>'), requests).latest(id, '1.2.3')
  assert.equal(result, undefined)
  assert.equal(requests.length, 1)
})
