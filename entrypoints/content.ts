export default defineContentScript({
  matches: ["file:///", "<all_urls>"],
  main() {
    console.log('Hello content.');
  },
});
