import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

export default defineConfig({
  // @ts-expect-error https://wxt.dev/api/reference/wxt/testing/functions/WxtVitest.html
  plugins: [WxtVitest()],
});