export const PROTOCOL_VERSION = 1 as const
export const MAX_CHECKIN_BODY_BYTES = 2 * 1024
export const MAX_ADMIN_JSON_BODY_BYTES = 16 * 1024
export const MAX_ASSET_BYTES = 2 * 1024 * 1024
export const MAX_LAUNCH_COUNT = 2_147_483_647
export const MAX_BROADCASTS_PER_CHECKIN = 40

export const BROADCAST_TYPES = [
  'welcome',
  'seasonal',
  'announcement',
  'security',
  'update_notice'
] as const

export const RELEASE_SEVERITIES = ['optional', 'recommended', 'important', 'critical'] as const
export const ASSET_MIME_TYPES = ['image/png', 'image/webp', 'image/gif'] as const

export const JSON_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
})

export const CONTROL_PANEL_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
})
