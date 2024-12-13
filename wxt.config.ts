import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  runner: {
    startUrls: ["https://chooseyourstory.com/story/viewer/default.aspx?StoryId=11246"]
  },
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
});
