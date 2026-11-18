// The DevTools panel shows the live Scene in @andypf/json-viewer, and Scene
// text comes from arbitrary web pages. Searching it must keep that text text.
import '@andypf/json-viewer';
import { expect, it } from 'vitest';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it('does not turn page text into markup when the Scene is searched', async () => {
  const viewer = document.createElement('andypf-json-viewer') as HTMLElement & { data: unknown };
  viewer.setAttribute('show-toolbar', 'true');
  viewer.setAttribute('expanded', '10');
  document.body.append(viewer);
  viewer.data = { text: 'x<img id="injected" src="data:,">', other: 'needle' };
  await settle();

  const root = viewer.shadowRoot as ShadowRoot;
  const search = root.querySelector('.search-input') as HTMLInputElement;
  search.value = 'needle';
  search.dispatchEvent(new Event('input'));
  await settle();

  expect(root.querySelectorAll('.match')).toHaveLength(1); // search still highlights
  expect(root.querySelector('#injected')).toBeNull();
  viewer.remove();
});
