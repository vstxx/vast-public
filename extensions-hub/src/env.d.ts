interface Env {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  HUB_SIGNING_PRIVATE_KEY_PKCS8: string
  HUB_RATE_LIMIT_SECRET: string
  HUB_LEGAL_OPERATOR_NAME: string
  HUB_LEGAL_CONTACT_URL: string
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    HUB_SIGNING_PRIVATE_KEY_PKCS8: string
    HUB_RATE_LIMIT_SECRET: string
    HUB_LEGAL_OPERATOR_NAME: string
    HUB_LEGAL_CONTACT_URL: string
  }
}
