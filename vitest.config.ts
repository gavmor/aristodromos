import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact()],
  // WXT's `@` alias (the project root), which the vendored components import through.
  resolve: {
    // Packages that ship CJS under `node` would `require('react')` past the alias; take their ESM build.
    conditions: ['module', 'browser', 'import', 'default'],
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      'react-dom/test-utils': 'preact/test-utils',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
      react: 'preact/compat',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Dependencies bundled, not externalised, so their `react` imports reach preact/compat as in the build.
    server: { deps: { inline: true } },
  },
});
