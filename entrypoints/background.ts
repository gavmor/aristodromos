export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: { type: string; value: number }, sender, sendResponse) => {
    if (message.type === 'ping') {
      // Non-deterministic wait: 0-2000ms random delay
      new Promise((resolve) => setTimeout(resolve, Math.random() * 2000)).then(() => {
        // Non-idempotent: Date.now() produces different results on each call
        const modified = message.value + (Date.now() % 100);
        console.log('bg: ping →', message.value, '| pong →', modified, '| after wait | from tab:', sender.tab?.id);
        sendResponse({ type: 'pong', value: modified });
      });

      return true; // Keep channel open for async sendResponse
    }
  });
});
