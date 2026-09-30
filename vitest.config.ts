import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      /*
       * `server-only` picks its entry point from the `react-server` export
       * condition, which Next sets and Vitest does not — so importing it here
       * would resolve to the module whose whole job is to throw. The guard
       * still does its real work at build time; this just stubs it out for the
       * tests, which are server code by definition.
       */
      'server-only': path.resolve(import.meta.dirname, './tests/stubs/server-only.ts'),
    },
  },
})
