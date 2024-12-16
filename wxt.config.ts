import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  runner: {
    binaries: {
      firefox: 'firefox-nightly',
    },
    startUrls: ["https://chooseyourstory.com/story/viewer/default.aspx?StoryId=11246"]
  },
  extensionApi: 'webextension-polyfill',
  modules: ['@wxt-dev/module-react'],
});
