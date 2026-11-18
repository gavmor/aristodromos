// Gemini lists every model, including ones that cannot chat; only the ones that
// can generate content are worth picking, by the id the API is called with.
import { afterEach, expect, it, vi } from 'vitest';
import { listModels } from '../utils/model-catalog';

afterEach(() => {
  vi.unstubAllGlobals();
});

it("lists Gemini's chat models by id, asking with the API key", async () => {
  const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const models = await listModels('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'k');
  expect(models).toEqual(['gemini-2.5-flash']);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('k');
});
