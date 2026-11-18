// The language model a config names: the one model the background hands to both
// the brain and the value filler, so the two can never disagree about it.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ollama-ai-provider-v2';
import type { AgentConfig } from './agent-config';

export function languageModelFor(config: AgentConfig) {
  switch (config.provider) {
    case 'openai-compatible':
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: config.baseURL }).chatModel(config.model);
    case 'gemini':
      return createGoogleGenerativeAI({ baseURL: config.baseURL, apiKey: config.apiKey ?? '' }).chat(config.model);
    default:
      return createOllama({ baseURL: config.baseURL }).chat(config.model);
  }
}
