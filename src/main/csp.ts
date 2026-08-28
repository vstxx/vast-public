const baseDirectives = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
]

export function packagedAppChromeCsp(): string {
  return [
    ...baseDirectives,
    "script-src 'self'",
    "connect-src 'self'",
    "frame-src 'self' http://127.0.0.1:*"
  ].join('; ')
}

export function devAppChromeCsp(): string {
  return [
    ...baseDirectives,
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
    "frame-src 'self' http: https: blob:"
  ].join('; ')
}

export function appChromeCsp(isPackaged: boolean): string {
  return isPackaged ? packagedAppChromeCsp() : devAppChromeCsp()
}
