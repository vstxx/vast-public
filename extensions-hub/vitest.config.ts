import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { TEST_SIGNING_KEY_ID, TEST_SIGNING_PRIVATE_PKCS8 } from './tests/fixtures/test-signing-key.ts'

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: path.join(import.meta.dirname, 'wrangler.jsonc') },
    miniflare: {
      serviceBindings: {
        HUB_SIGNER: async () => new Response('Signer is not called by the test-only local signing path.', { status: 503 })
      },
      bindings: {
        ENVIRONMENT: 'test',
        HUB_SIGNING_PRIVATE_KEY_PKCS8: TEST_SIGNING_PRIVATE_PKCS8,
        GITHUB_CLIENT_ID: 'test-github-client',
        GITHUB_CLIENT_SECRET: 'test-github-secret',
        HUB_LEGAL_OPERATOR_NAME: 'Fixture Legal Operator',
        HUB_LEGAL_CONTACT_URL: 'https://legal.test/contact',
        SIGNING_KEY_ID: TEST_SIGNING_KEY_ID,
        TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations'))
      }
    }
  }))],
  root: import.meta.dirname,
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 }
})
