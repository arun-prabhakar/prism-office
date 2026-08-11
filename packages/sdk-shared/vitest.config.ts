import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // jsdom for the SDK (DOM API + iframe + postMessage); individual tests can
    // override with `// @vitest-environment node` if they want Node.
    environment: 'jsdom',
  },
})
