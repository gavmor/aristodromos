import { useStore } from '@/lib/store' // Ensure '@' alias maps to your src/ root

export default defineContentScript({
  main() {
    const targetElement = document.querySelector('h1')

    if (targetElement) {
      const text = targetElement.textContent?.trim()

      // Instead of alerting, we write to the store
      // getState() is used here to avoid React hook rules outside of components
      const state = useStore.getState()

      // Only update if different to avoid infinite loops/unnecessary writes
      if (state.scrapedData !== text) {
        console.warn('[Content Script] Updating store with:', text)
        state.setScrapedData(text)
      }
    }
  },
  matches: ['<all_urls>'],

  runAt: 'document_end',
})
