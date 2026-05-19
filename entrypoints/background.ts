export default defineBackground(() => {
  console.log('Hello from background!', { id: browser.runtime.id });
});
