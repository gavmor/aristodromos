import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  srcDir: '.',
  // The popup and panel are Preact function components (TSX); the vendored React
  // components (components/) run through preact/compat and are styled by Tailwind.
  vite: () => ({ plugins: [preact(), tailwindcss()] }),
  // The Firefox sources zip is for AMO review; WXT does not read .gitignore,
  // so local, ignored files are kept out here.
  zip: { excludeSources: ['ruvector.db', 'lib/**', '*.local', '.env', '.env.*'] },
  manifest: ({ browser }) => ({
    // The display name; WXT would otherwise take package.json's lowercase name.
    name: 'Aristodromos',
    // `storage` holds the goal and the turn log across service-worker eviction;
    // `<all_urls>` covers both the pages we drive and the local Ollama the
    // background worker fetches from.
    permissions: ['storage'],
    host_permissions: ['<all_urls>'],
    action: {},
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          // A stable add-on id: storage and AMO signing are keyed on it.
          id: 'aristodromos@gavmor.github.io',
          // `data_collection_permissions` is read from Firefox 140 on.
          strict_min_version: '140.0',
          // Page content goes to the model server the user configures (local
          // Ollama by default, but any URL), so it is declared, not assumed local.
          data_collection_permissions: { required: ['websiteContent'] },
        },
      },
    }),
  }),
});
