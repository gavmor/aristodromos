// What models each provider's server offers, asked live.
//   Ollama:            GET {baseURL}/tags     (baseURL ends in /api)  → models[].name
//   OpenAI-compatible: GET {baseURL}/models   (baseURL ends in /v1)   → data[].id
//   Gemini:            GET {baseURL}/models   (baseURL ends in /v1beta, key in x-goog-api-key)
//                      → models[] that can generateContent, `models/` stripped
// The base URL is the one the AI SDK provider takes, so listing and calling agree.
import type { Provider } from './agent-config';

interface Listing {
  models?: { name: string; supportedGenerationMethods?: string[] }[];
  data?: { id: string }[];
}

/** The model ids on the server; rejects with why when it does not answer usefully. */
export async function listModels(provider: Provider, baseURL: string, apiKey?: string): Promise<string[]> {
  const root = baseURL.replace(/\/+$/, '');
  const url = provider === 'ollama' ? `${root}/tags` : `${root}/models`;
  const headers: Record<string, string> = provider === 'gemini' && apiKey ? { 'x-goog-api-key': apiKey } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as Listing;
  if (provider === 'openai-compatible') return (body.data ?? []).map((model) => model.id);
  if (provider === 'gemini') {
    return (body.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map((model) => model.name.replace(/^models\//, ''));
  }
  return (body.models ?? []).map((model) => model.name);
}
