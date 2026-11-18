// The model picker in the shared form lists each provider's models live when it
// opens. A provider that does not answer is shown, but nothing in it can be
// chosen: picking a model the agent cannot reach would only fail later.
import { render } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type AgentConfig, CONFIG_KEY } from '../utils/agent-config';
import { ConfigForm } from '../utils/config-form';
import { installFakeBrowser, settle } from './fake-browser';

const STORED: AgentConfig = {
  goal: '',
  provider: 'ollama',
  model: 'llama3',
  baseURL: 'http://127.0.0.1:11434/api',
};

beforeEach(async () => {
  // jsdom lacks what the popover's positioning and list scrolling reach for.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url) === 'http://127.0.0.1:11434/api/tags') {
        return Response.json({ models: [{ name: 'llama3' }, { name: 'qwen3:8b' }] });
      }
      throw new TypeError('Failed to fetch');
    }),
  );
  const fake = installFakeBrowser();
  await fake.storage.local.set({ [CONFIG_KEY]: STORED });
  render(null, document.body);
  render(<ConfigForm submitLabel="Start" />, document.body);
  await settle();
});

afterEach(() => {
  render(null, document.body);
  vi.unstubAllGlobals();
});

const trigger = () => document.querySelector('[data-slot="model-selector-trigger"]') as HTMLButtonElement;
const modelField = () => (document.getElementById('model') as HTMLInputElement).value;

async function openPicker(): Promise<void> {
  trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  trigger().click();
  await settle();
}

function group(label: string): HTMLElement {
  const groups = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-group"]')];
  const found = groups.find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`no "${label}" group in ${document.body.innerHTML}`);
  return found;
}

const items = (of: HTMLElement) => [...of.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')];

it('shows an unreachable provider as a disabled group that says why', async () => {
  await openPicker();
  const unreachable = group('OpenAI-compatible');
  expect(unreachable.textContent).toContain('no answer');
  expect(items(unreachable).length).toBeGreaterThan(0);
  for (const item of items(unreachable)) expect(item.getAttribute('aria-disabled')).toBe('true');
});

it('cannot select a model of an unreachable provider, but can select a listed one', async () => {
  await openPicker();
  for (const item of items(group('OpenAI-compatible'))) item.click();
  await settle();
  expect(modelField()).toBe('llama3');

  const listed = items(group('Ollama')).find((item) => item.textContent?.includes('qwen3:8b'));
  listed?.click();
  await settle();
  expect(modelField()).toBe('qwen3:8b');
});
