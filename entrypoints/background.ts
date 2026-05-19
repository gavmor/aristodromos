export default defineBackground(() => {
  // Track pings per tab for B2C batch updates
  const pingCounters = new Map<number, number>();

  browser.runtime.onMessage.addListener((message: { type: string; value: number; metadata?: Map<string, unknown> }, sender, sendResponse) => {
    if (message.type === 'ping') {
      const tabId = sender.tab?.id;
      if (tabId == null) return;

      // Log structured-clone-native types if present
      if (message.metadata instanceof Map) {
        console.log('bg: received Map metadata —', Object.fromEntries(message.metadata));
      }

      // Non-deterministic wait: 0-2000ms random delay
      new Promise((resolve) => setTimeout(resolve, Math.random() * 2000)).then(() => {
        // Non-idempotent: Date.now() produces different results on each call
        const modified = message.value + (Date.now() % 100);
        console.log('bg: ping →', message.value, '| pong →', modified, '| tab:', tabId);
        sendResponse({ type: 'pong', value: modified });

        // B2C: every 3rd ping, push a batch update back to the content script
        const count = (pingCounters.get(tabId) ?? 0) + 1;
        pingCounters.set(tabId, count);

        if (count % 3 === 0) {
          const batchMetadata = new Map<string, unknown>([
            ['totalPings', count],
            ['lastBatchAt', new Date()],
          ]);

          browser.tabs.sendMessage(tabId, {
            direction: 'B2C',
            type: 'PONG_BATCH',
            payload: { batch: count / 3, metadata: batchMetadata },
          }).catch(() => {
            /* content script may not be listening */
          });
        }
      });

      return true; // Keep channel open for async sendResponse
    }
  });
});
