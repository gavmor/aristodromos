import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    default_locale: 'en',
    description: '__MSG_extension_description__',
    host_permissions: [],
    name: '__MSG_extension_name__',
    permissions: ['storage'],
  },
  modules: [
    '@wxt-dev/module-react',
    '@wxt-dev/auto-icons',
    '@wxt-dev/i18n/module',
  ],
  runner: { startUrls: ['https://chooseyourstory.com/story/viewer/default.aspx?StoryId=11246'] },
  srcDir: 'src',
  vite: () => ({
    plugins: [tailwindcss() as any],
  }),
})
