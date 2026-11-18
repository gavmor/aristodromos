// The model the background hands to the brain and the value filler must be the
// provider and model the config names, and a config stored before providers
// existed must keep running on Ollama.
import { afterEach, expect, it, vi } from 'vitest';
import { type AgentConfig, resolveConfig } from '../utils/agent-config';
import { languageModelFor } from '../utils/inference';

/** The URL and model of the first request the model makes; the call itself is cut short. */
async function firstRequest(config: AgentConfig): Promise<{ url: string; model: unknown }> {
  const fetchSpy = vi.fn(async () => {
    throw new Error('stop here');
  });
  vi.stubGlobal('fetch', fetchSpy);
  await Promise.resolve(
    languageModelFor(config).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  ).catch(() => {});
  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  return { url: String(url), model: JSON.parse(String(init.body)).model };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('calls the OpenAI-compatible server and model the config selects', async () => {
  const config = resolveConfig({
    goal: '',
    provider: 'openai-compatible',
    model: 'qwen3-8b',
    baseURL: 'http://127.0.0.1:1234/v1',
  });
  expect(await firstRequest(config)).toEqual({ url: 'http://127.0.0.1:1234/v1/chat/completions', model: 'qwen3-8b' });
});

it('calls the Ollama server and model the config selects', async () => {
  const config = resolveConfig({
    goal: '',
    provider: 'ollama',
    model: 'llama3',
    baseURL: 'http://127.0.0.1:11434/api',
  });
  expect(await firstRequest(config)).toEqual({ url: 'http://127.0.0.1:11434/api/chat', model: 'llama3' });
});

it('runs a stored config without a provider on Ollama', async () => {
  const config = resolveConfig({ goal: 'g', model: 'llama3', baseURL: 'http://127.0.0.1:11434/api' });
  expect(config.provider).toBe('ollama');
  expect(await firstRequest(config)).toEqual({ url: 'http://127.0.0.1:11434/api/chat', model: 'llama3' });
});

it('calls Gemini with the configured model and API key', async () => {
  const fetchSpy = vi.fn(async () => {
    throw new Error('stop here');
  });
  vi.stubGlobal('fetch', fetchSpy);
  const config = resolveConfig({
    goal: '',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'test-key',
  });
  await Promise.resolve(
    languageModelFor(config).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  ).catch(() => {});
  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  expect(new Headers(init.headers).get('x-goog-api-key')).toBe('test-key');
});
