import { describe, expect, it, vi } from 'vitest';
import type { SemanticPageMap } from '../utils/semantic-map';
import {
  buildPrompt,
  callOllama,
  formatGoal,
  LLMStrategy,
  parseModelResponse,
} from '../utils/llm-strategy';

describe('formatGoal', () => {
  it('formats string goals directly', () => {
    expect(formatGoal('Search for shoes')).toBe('Search for shoes');
  });

  it('extracts description from goal objects', () => {
    expect(formatGoal({ description: 'Complete checkout flow', priority: 1 })).toBe(
      'Complete checkout flow',
    );
  });

  it('stringifies object goals without description', () => {
    expect(formatGoal({ target: 'home' } as any)).toBe(JSON.stringify({ target: 'home' }));
  });
});

describe('buildPrompt', () => {
  it('contains every label and id, including current_value for state targets', () => {
    const map: SemanticPageMap = {
      state_targets: [
        {
          id: 'query_input',
          type: 'text_input',
          label: 'Search Field',
          current_value: 'mechanical keyboards',
        },
        {
          id: 'filter_active',
          type: 'checkbox',
          label: 'In Stock Only',
          current_value: true,
        },
        {
          id: 'quantity_field',
          type: 'number_input',
          label: 'Item Quantity',
          current_value: 2,
        },
      ],
      trigger_elements: [
        {
          id: 'search_button',
          type: 'button_click',
          label: 'Perform Search',
        },
        {
          id: 'details_link',
          type: 'link_navigation',
          label: 'View Product Details',
        },
      ],
    };

    const prompt = buildPrompt(map, 'Find mechanical keyboards');

    // Goal is present
    expect(prompt).toContain('Find mechanical keyboards');

    // Every state target: id, type, label, current_value
    for (const target of map.state_targets) {
      expect(prompt).toContain(target.id);
      expect(prompt).toContain(target.type);
      expect(prompt).toContain(target.label);
      expect(prompt).toContain(JSON.stringify(target.current_value));
    }

    // Every trigger element: id, type, label
    for (const trigger of map.trigger_elements) {
      expect(prompt).toContain(trigger.id);
      expect(prompt).toContain(trigger.type);
      expect(prompt).toContain(trigger.label);
    }
  });

  it('handles empty affordances cleanly', () => {
    const map: SemanticPageMap = {
      state_targets: [],
      trigger_elements: [],
    };

    const prompt = buildPrompt(map, 'Idle observation');
    expect(prompt).toContain('(none)');
    expect(prompt).toContain('Idle observation');
  });
});

describe('parseModelResponse', () => {
  const sampleMap: SemanticPageMap = {
    state_targets: [
      { id: 'user_email', type: 'text_input', label: 'Email', current_value: '' },
      { id: 'newsletter_opt', type: 'checkbox', label: 'Newsletter', current_value: false },
    ],
    trigger_elements: [
      { id: 'btn_submit', type: 'button_click', label: 'Register' },
      { id: 'btn_cancel', type: 'button_click', label: 'Cancel' },
    ],
  };

  it('parses valid JSON response into the correct plan', () => {
    const responseText = JSON.stringify({
      state_targets: [{ id: 'user_email', value: 'alice@example.com' }],
      trigger_intents: [{ action: 'click', id: 'btn_submit' }],
    });

    const plan = parseModelResponse(responseText, sampleMap);

    expect(plan.state_targets).toEqual([
      { id: 'user_email', value: 'alice@example.com' },
    ]);
    expect(plan.trigger_intents).toEqual([
      { action: 'click', id: 'btn_submit' },
    ]);
  });

  it('handles markdown code fences around JSON', () => {
    const responseText = `Here is the requested plan:
\`\`\`json
{
  "state_targets": [{ "id": "user_email", "value": "bob@example.com" }],
  "trigger_intents": [{ "action": "click", "id": "btn_submit" }]
}
\`\`\``;

    const plan = parseModelResponse(responseText, sampleMap);

    expect(plan.state_targets).toEqual([
      { id: 'user_email', value: 'bob@example.com' },
    ]);
    expect(plan.trigger_intents).toEqual([
      { action: 'click', id: 'btn_submit' },
    ]);
  });

  it('filters out hallucinated ids not present in the map', () => {
    const responseText = JSON.stringify({
      state_targets: [
        { id: 'user_email', value: 'valid@example.com' },
        { id: 'hallucinated_password_input', value: 'secret' },
        { id: 'btn_submit', value: 'wrong_affordance_type' },
      ],
      trigger_intents: [
        { action: 'click', id: 'btn_submit' },
        { action: 'click', id: 'hallucinated_checkout_button' },
        { action: 'click', id: 'user_email' },
      ],
    });

    const plan = parseModelResponse(responseText, sampleMap);

    // Only valid state targets that exist in map.state_targets
    expect(plan.state_targets).toEqual([
      { id: 'user_email', value: 'valid@example.com' },
    ]);
    // Only valid trigger elements that exist in map.trigger_elements
    expect(plan.trigger_intents).toEqual([
      { action: 'click', id: 'btn_submit' },
    ]);
  });

  it('yields an empty plan when model output contains only hallucinated ids', () => {
    const responseText = JSON.stringify({
      state_targets: [{ id: 'fake_1', value: 'val' }],
      trigger_intents: [{ action: 'click', id: 'fake_2' }],
    });

    const plan = parseModelResponse(responseText, sampleMap);
    expect(plan).toEqual({ state_targets: [], trigger_intents: [] });
  });

  it('yields an empty plan on malformed JSON without throwing', () => {
    const malformedCases = [
      '{ invalid json here',
      'Plain prose with no JSON at all',
      '',
      null as any,
      undefined as any,
      '{"state_targets": 123}',
      '[1, 2, 3]',
    ];

    for (const testCase of malformedCases) {
      expect(() => parseModelResponse(testCase, sampleMap)).not.toThrow();
      expect(parseModelResponse(testCase, sampleMap)).toEqual({
        state_targets: [],
        trigger_intents: [],
      });
    }
  });
});

describe('callOllama', () => {
  it('sends POST request to localhost:11434 with format: json and configured model', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({ state_targets: [], trigger_intents: [] }),
      }),
    });

    const res = await callOllama({
      baseURL: 'http://localhost:11434',
      model: 'qwen2.5:7b',
      prompt: 'test prompt',
      fetch: mockFetch as any,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];

    expect(url).toBe('http://localhost:11434/api/generate');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({
      model: 'qwen2.5:7b',
      prompt: 'test prompt',
      format: 'json',
      stream: false,
    });

    expect(res).toBe(JSON.stringify({ state_targets: [], trigger_intents: [] }));
  });

  it('throws on HTTP error status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    await expect(
      callOllama({
        baseURL: 'http://localhost:11434',
        model: 'qwen2.5:7b',
        prompt: 'test',
        fetch: mockFetch as any,
      }),
    ).rejects.toThrow('Ollama HTTP error 503: Service Unavailable');
  });
});

describe('LLMStrategy', () => {
  const testMap: SemanticPageMap = {
    state_targets: [
      { id: 'search_box', type: 'text_input', label: 'Search', current_value: '' },
    ],
    trigger_elements: [
      { id: 'btn_go', type: 'button_click', label: 'Go' },
    ],
  };

  it('targets localhost:11434 with configured model', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          state_targets: [{ id: 'search_box', value: 'vitest' }],
          trigger_intents: [{ action: 'click', id: 'btn_go' }],
        }),
      }),
    });

    const strategy = new LLMStrategy({
      model: 'qwen2.5-coder:7b',
      baseURL: 'http://localhost:11434',
      fetch: mockFetch as any,
    });

    const plan = await strategy.decide(testMap, 'Search for vitest');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('localhost:11434');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen2.5-coder:7b');
    expect(body.format).toBe('json');
    expect(body.stream).toBe(false);

    expect(plan).toEqual({
      state_targets: [{ id: 'search_box', value: 'vitest' }],
      trigger_intents: [{ action: 'click', id: 'btn_go' }],
    });
  });

  it('yields an empty plan when HTTP error occurs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const strategy = new LLMStrategy({
      model: 'qwen-model',
      fetch: mockFetch as any,
    });

    const plan = await strategy.decide(testMap, 'Any goal');
    expect(plan).toEqual({ state_targets: [], trigger_intents: [] });
  });

  it('yields an empty plan on network exception / fetch failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const strategy = new LLMStrategy({
      fetch: mockFetch as any,
    });

    const plan = await strategy.decide(testMap, 'Any goal');
    expect(plan).toEqual({ state_targets: [], trigger_intents: [] });
  });

  it('yields an empty plan when response body contains malformed JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '<<<not valid json>>>',
      }),
    });

    const strategy = new LLMStrategy({
      fetch: mockFetch as any,
    });

    const plan = await strategy.decide(testMap, 'Any goal');
    expect(plan).toEqual({ state_targets: [], trigger_intents: [] });
  });

  it('filters out hallucinated ids through decide', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          state_targets: [
            { id: 'search_box', value: 'headphones' },
            { id: 'nonexistent_input', value: 'hack' },
          ],
          trigger_intents: [
            { action: 'click', id: 'nonexistent_btn' },
          ],
        }),
      }),
    });

    const strategy = new LLMStrategy({
      fetch: mockFetch as any,
    });

    const plan = await strategy.decide(testMap, 'Find headphones');
    expect(plan).toEqual({
      state_targets: [{ id: 'search_box', value: 'headphones' }],
      trigger_intents: [],
    });
  });
});
