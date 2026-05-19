export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    // Derive initial value from the DOM: count all elements on the page
    let value = document.querySelectorAll('*').length;

    const intervalId = setInterval(async () => {
      if (ctx.isInvalidated) {
        clearInterval(intervalId);
        return;
      }

      try {
        const response = await browser.runtime.sendMessage({
          type: 'ping',
          value,
        });

        if (response.type === 'pong') {
          // Non-idempotent: Math.random() produces different results on each call
          value = response.value + Math.random();
          console.log('cs: sent →', response.value, '| next →', value);
        }
      } catch (err) {
        console.error('cs: ping-pong failed', err);
      }
    }, 5000);

    ctx.onInvalidated(() => {
      clearInterval(intervalId);
    });
  },
});
