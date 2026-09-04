import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { relayBuildConfigFromEnv } from './src/shared/relay-config'

const embeddedBuildEnv = {
  VAST_RELEASE_CHANNEL: process.env.VAST_RELEASE_CHANNEL,
  VAST_DISTRIBUTION_CHANNEL: process.env.VAST_DISTRIBUTION_CHANNEL,
  VAST_UPDATE_ENABLED: process.env.VAST_UPDATE_ENABLED,
  VAST_OBFUSCATE: process.env.VAST_OBFUSCATE,
  VAST_PRIVATE_BUILD: process.env.VAST_PRIVATE_BUILD,
  VAST_RELEASE_REPO: process.env.VAST_RELEASE_REPO,
  VAST_PERFORMANCE_GPU: process.env.VAST_PERFORMANCE_GPU,
  VAST_SAFE_GPU: process.env.VAST_SAFE_GPU
}

const embeddedNoticesTrust = {
  enabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.VAST_NOTICES_ENABLED ?? '').trim().toLowerCase()),
  feedUrl: String(process.env.VAST_NOTICES_FEED_URL ?? '').trim(),
  keyId: String(process.env.VAST_NOTICES_KEY_ID ?? '').trim(),
  publicKeySpkiBase64: String(process.env.VAST_NOTICES_PUBLIC_KEY_SPKI_BASE64 ?? '').trim()
}

const includeInternalTestHarness = process.env.VAST_INCLUDE_INTERNAL_TEST_HARNESS === '1'
const embeddedRelayConfig = relayBuildConfigFromEnv(process.env)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      // The renderer bundles the complete PSL where it is needed. The main
      // process loads the same audited data from one minimal extra resource so
      // it does not grow the startup bundle or ship tldts' source/maps twice.
      alias: [{ find: /^tldts$/, replacement: resolve(__dirname, 'src/main/tldts-runtime.ts') }]
    },
    define: {
      __VAST_BUILD_ENV__: JSON.stringify(embeddedBuildEnv),
      __VAST_NOTICES_TRUST__: JSON.stringify(embeddedNoticesTrust),
      __VAST_INCLUDE_INTERNAL_TEST_HARNESS__: JSON.stringify(includeInternalTestHarness),
      __VAST_RELAY_CONFIG__: JSON.stringify(embeddedRelayConfig)
    },
    build: {
      outDir: 'out/main',
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/main/main.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'guest-autofill': resolve(__dirname, 'src/preload/guest-autofill.ts'),
          'extension-host': resolve(__dirname, 'src/preload/extension-host.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      outDir: 'out/renderer',
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    }
  }
})
