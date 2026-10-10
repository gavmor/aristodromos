import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  srcDir: '.',
  manifest: {
    // `storage` holds the goal and the turn log across service-worker eviction;
    // `<all_urls>` covers both the pages we drive and the local Ollama the
    // background worker fetches from.
    permissions: ['storage'],
    host_permissions: ['<all_urls>'],
    action: {},
  },
});
