import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Session } from 'electron/main'
import { resolveExtensionAssetPath } from './extension-manifest.ts'
import type { ValidatedExtensionManifest } from './extension-types.ts'

export const VAST_EXTENSION_SCHEME = 'vast-extension'
export const VAST_EXTENSION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
}

function response(body: BodyInit | null, status: number, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType, 'content-security-policy': VAST_EXTENSION_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
}

export class ExtensionResourceProtocol {
  private manifests = new Map<string, ValidatedExtensionManifest>()
  private sessions = new WeakSet<Session>()

  set(id: string, manifest: ValidatedExtensionManifest): void { this.manifests.set(id, manifest) }
  remove(id: string): void { this.manifests.delete(id) }

  async register(target: Session): Promise<void> {
    if (this.sessions.has(target)) return
    await target.protocol.handle(VAST_EXTENSION_SCHEME, async (request) => this.handle(request))
    this.sessions.add(target)
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET' || url.protocol !== `${VAST_EXTENSION_SCHEME}:` || url.username || url.password || url.port || url.search || url.hash) return response('Forbidden', 403)
      const id = url.hostname
      const manifest = this.manifests.get(id)
      if (!manifest?.vast) return response('Not found', 404)
      let pathname: string
      try { pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '') } catch { return response('Bad request', 400) }
      if (!pathname || pathname.includes('\0') || pathname.split('/').includes('..')) return response('Not found', 404)
      if (pathname === '__vast_background__.html') {
        if (!manifest.vast.background) return response('Not found', 404)
        const source = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VAST_EXTENSION_CSP}"></head><body><script type="module" src="/${encodeURI(manifest.vast.background)}"></script></body></html>`
        return response(source, 200, 'text/html; charset=utf-8')
      }
      const file = await resolveExtensionAssetPath(manifest.rootPath, pathname)
      const info = await stat(file)
      if (!info.isFile() || info.size > 10 * 1024 * 1024) return response('Not found', 404)
      return response(await readFile(file), 200, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
    } catch {
      return response('Not found', 404)
    }
  }
}
