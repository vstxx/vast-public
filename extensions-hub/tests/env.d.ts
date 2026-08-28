import type { D1Migration } from '@cloudflare/vitest-plugin'

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
  }
}

declare global {
  interface Env {
    TEST_MIGRATIONS: D1Migration[]
  }
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
