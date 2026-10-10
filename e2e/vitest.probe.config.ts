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
    // The probe's console output IS its product — the option set, the full
    // probability distribution, the chosen label, the decoded action. Vitest's
    // reporter buffers intercepted console output and then drops it for tests
    // that PASS, which is exactly backwards here: a green run with no numbers
    // to read is the outcome this file exists to prevent. Writing straight
    // through also keeps the log in real time, which matters when one
    // classification takes minutes on CPU.
    disableConsoleIntercept: true,
  },
});
