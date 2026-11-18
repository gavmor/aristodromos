// The config form outside DevTools (the popup, or the panel page opened as a
// plain tab) must show exactly what storage holds: a field that disagrees with
// the stored config is a form that lies about what the agent will do.
import { render } from 'preact';
import { beforeEach, expect, it } from 'vitest';
import { type AgentConfig, CONFIG_KEY } from '../utils/agent-config';
import { TabForm } from '../utils/run-switch';
import { type FakeBrowser, installFakeBrowser, settle } from './fake-browser';

const STORED: AgentConfig = {
  goal: 'Reach the end of the page.',
  provider: 'gemini',
  model: 'some-model:7b',
  baseURL: 'http://127.0.0.1:9999/api',
  apiKey: 'stored-key',
  systemOne: { baseURL: 'http://127.0.0.1:18081', model: 'classifier', threshold: 0.35 },
  tracing: { endpoint: 'http://127.0.0.1:6007/v1/traces', project: 'elsewhere' },
};

const field = <T extends HTMLInputElement | HTMLTextAreaElement>(id: string) => document.getElementById(id) as T;

function fieldsOf(): AgentConfig {
  return {
    goal: field('goal').value,
    provider: document.getElementById('model-picker')?.dataset.provider as AgentConfig['provider'],
    model: field('model').value,
    baseURL: field('base-url').value,
    apiKey: field('api-key').value || undefined,
    systemOne: field<HTMLInputElement>('so-enabled').checked
      ? {
          baseURL: field('so-base-url').value,
          model: field('so-model').value,
          threshold: Number(field('so-threshold').value),
        }
      : undefined,
    tracing: field<HTMLInputElement>('tr-enabled').checked
      ? { endpoint: field('tr-endpoint').value, project: field('tr-project').value }
      : undefined,
  };
}

/** The shared form, mounted the way the popup and the panel mount it, with no DevTools around it. */
function renderForm(): void {
  render(null, document.body);
  render(<TabForm tabId={1} running={false} />, document.body);
}

let fake: FakeBrowser;

beforeEach(() => {
  fake = installFakeBrowser();
});

it('shows the stored config in every field, and follows it when it changes', async () => {
  await fake.storage.local.set({ [CONFIG_KEY]: STORED });
  renderForm();
  await settle();
  expect(fieldsOf()).toEqual(STORED);

  const changed: AgentConfig = {
    goal: 'Another goal.',
    provider: 'ollama',
    model: 'other',
    baseURL: 'http://127.0.0.1:1/api',
  };
  await fake.storage.local.set({ [CONFIG_KEY]: changed });
  await settle();
  expect(fieldsOf()).toEqual({ ...changed, apiKey: undefined, systemOne: undefined, tracing: undefined });
});
