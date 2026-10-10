import { defineConfig } from 'vitest/config';

/**
 * The live probe runs on its own config so it can never be swept into
 * `pnpm test`: the root config collects `tests/**` only, and a gate must not
 * depend on a 16 GiB model being resident.
 *
 * `node` environment, not jsdom: the probe builds its OWN JSDOM per page state
 * so the fixture's inline script actually runs, which is what enables the submit
 * button. A pre-installed global document would not execute it.
 *
 * The timeout is generous because a 27B classifier may be serving from CPU.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    testTimeout: Number(process.env.JEV_TIMEOUT_MS ?? 900_000),
    hookTimeout: 60_000,
  },
});
