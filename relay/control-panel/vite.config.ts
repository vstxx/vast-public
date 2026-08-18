import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  css: {
    postcss: { plugins: [] }
  },
  build: {
    emptyOutDir: true,
    outDir: path.join(root, 'dist'),
    sourcemap: false,
    target: 'es2022'
  }
})
