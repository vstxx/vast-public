import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const directory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(directory, 'migrations'))
  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: './public/wrangler.jsonc',
          environment: 'staging'
        },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations }
        }
      })
    ],
    test: {
      setupFiles: ['./tests/apply-migrations.ts'],
      include: ['./tests/**/*.test.ts'],
      testTimeout: 15_000,
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ['semver']
          }
        }
      }
    }
  }
})
