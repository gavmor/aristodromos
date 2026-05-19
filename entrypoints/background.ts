export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: { type: string; value: number }, sender) => {
    if (message.type === 'ping') {
      // Non-idempotent: Date.now() produces different results on each call
      const modified = message.value + (Date.now() % 100);
      console.log('bg: ping →', message.value, '| pong →', modified, '| from tab:', sender.tab?.id);
      return Promise.resolve({ type: 'pong', value: modified });
    }
  });
});
