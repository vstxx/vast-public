import { canonicalJson, createEd25519Signer, createVextPackage, VEXT_EXTENSION_ID, VEXT_LIMITS, VEXT_PUBLISHER_ID, VEXT_VERSION } from '../../src/shared/vext-format.ts'
import { createHubSignerProofPayload } from '../../src/shared/hub-signer-proof.ts'
import { validatePublisherPackage } from './validation.ts'

interface SignerEnv {
  SIGNING_KEY_ID: string
  HUB_SIGNING_PRIVATE_KEY_PKCS8: string
  HUB_ORIGIN: string
}

function error(message: string, status = 400): Response {
  return Response.json({ error: message }, { status })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export default {
  async fetch(request: Request, env: SignerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/v1/key') {
      return Response.json({ algorithm: 'Ed25519', keyId: env.SIGNING_KEY_ID })
    }
    const signer = await createEd25519Signer(env.SIGNING_KEY_ID, env.HUB_SIGNING_PRIVATE_KEY_PKCS8)
    if (request.method === 'GET' && url.pathname === '/v1/proof') {
      const payload = createHubSignerProofPayload(env.SIGNING_KEY_ID, env.HUB_ORIGIN)
      return Response.json({ keyId: env.SIGNING_KEY_ID, payload, signature: bytesToBase64(await signer.sign(new TextEncoder().encode(payload))) })
    }
    if (request.method === 'POST' && url.pathname === '/v1/package') {
      const extensionId = request.headers.get('x-vast-extension-id') ?? ''
      const publisherId = request.headers.get('x-vast-publisher-id') ?? ''
      const version = request.headers.get('x-vast-version') ?? ''
      const declared = Number(request.headers.get('content-length') || 0)
      if (declared > VEXT_LIMITS.maxCompressedBytes) return error('Package is too large.', 413)
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > VEXT_LIMITS.maxCompressedBytes) return error('Package is too large.', 413)
      const summary = await validatePublisherPackage(bytes, extensionId, publisherId)
      if (summary.version !== version) return error('Package version does not match the signing request.', 409)
      const official = await createVextPackage({ extensionId, version, publisherId, files: summary.parsed.files, signer })
      return new Response(official.slice().buffer, { headers: { 'Content-Type': 'application/vnd.vast.extension+zip', 'X-Vast-Signing-Key-Id': env.SIGNING_KEY_ID } })
    }
    if (request.method === 'POST' && url.pathname === '/v1/descriptor') {
      const text = await request.text()
      if (text.length > 64 * 1024) return error('Descriptor is too large.', 413)
      let descriptor: unknown
      try { descriptor = JSON.parse(text) } catch { return error('Descriptor is invalid JSON.') }
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || canonicalJson(descriptor) !== text) return error('Descriptor is not canonical.')
      const record = descriptor as Record<string, unknown>
      let packageUrl: URL
      try { packageUrl = new URL(String(record.package_url)) } catch { return error('Descriptor is outside the signer policy.') }
      const allowedKeys = ['schema', 'extension_id', 'publisher_id', 'version', 'package_url', 'sha256', 'key_id', 'permissions', 'published_at']
      const permissions = record.permissions as Record<string, unknown> | undefined
      const hash = String(record.sha256 ?? '')
      const expectedPath = `/packages/${record.extension_id}/${record.version}/${hash}.vext`
      if (
        Object.keys(record).length !== allowedKeys.length || Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
        record.schema !== 1 || record.key_id !== env.SIGNING_KEY_ID ||
        !VEXT_EXTENSION_ID.test(String(record.extension_id)) || !VEXT_PUBLISHER_ID.test(String(record.publisher_id)) || !VEXT_VERSION.test(String(record.version)) ||
        !/^[a-f0-9]{64}$/.test(hash) || packageUrl.origin !== env.HUB_ORIGIN || packageUrl.pathname !== expectedPath || packageUrl.search || packageUrl.hash ||
        typeof record.published_at !== 'string' || !Number.isFinite(Date.parse(record.published_at)) ||
        !permissions || !Array.isArray(permissions.chrome) || !Array.isArray(permissions.hosts) || !Array.isArray(permissions.vast) ||
        [permissions.chrome, permissions.hosts, permissions.vast].some((items) => items.length > 512 || items.some((item) => typeof item !== 'string' || item.length > 4_096))
      ) return error('Descriptor is outside the signer policy.')
      const signature = await signer.sign(new TextEncoder().encode(text))
      return Response.json({ keyId: env.SIGNING_KEY_ID, signature: bytesToBase64(signature) })
    }
    return error('Not found.', 404)
  }
}
