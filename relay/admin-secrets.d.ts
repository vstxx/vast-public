// Wrangler generates resource/var types from wrangler.jsonc. Ordinary Worker
// Secrets intentionally do not appear in that file, so their names are merged
// here while their values remain exclusively in Cloudflare's secret bindings.
interface AdminEnv {
  RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64: string
  RELAY_NEXT_KEY_ID?: string
  RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64?: string
}
