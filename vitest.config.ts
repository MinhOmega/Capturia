import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: true,
    // `node`, not `jsdom`. Booting a jsdom for every test file is by far the
    // most expensive thing a suite like this does, and only the component /
    // hook tests need a DOM at all. Those opt back in with a
    // `// @vitest-environment jsdom` docblock on line 1 of the file, which is
    // also the fix when a new test dies on `document is not defined`.
    environment: 'node',
    include: ['{src,electron}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
