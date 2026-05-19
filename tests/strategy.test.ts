import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RandomClickStrategy } from '../utils/random-click-strategy';
import { LLMStrategy } from '../utils/agent';
import type { OperationSchema } from '../utils/types';

// ---------------------------------------------------------------------------
// RandomClickStrategy
// ---------------------------------------------------------------------------

describe('RandomClickStrategy', () => {
  const strategy = new RandomClickStrategy();

  const baseSchema: OperationSchema = {
    allowedPaths: ['/el-btn-0/clicked', '/el-btn-1/clicked', '/el-input-2/value'],
    allowedOperations: ['replace'],
    description: 'Test schema',
  };

  it('returns a name', () => {
    expect(strategy.name).toBe('random-click');
  });

  it('returns a single click operation with replace op and value true', async () => {
    const result = await strategy.decide(baseSchema, [], new AbortController().signal);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].op).toBe('replace');
    expect((result.operations[0] as any).value).toBe(true);
    expect(result.reasoning).toContain('click');
  });

  it('picks a path ending with /clicked', async () => {
    // Run multiple times to increase confidence in random selection
    for (let i = 0; i < 20; i++) {
      const result = await strategy.decide(baseSchema, [], new AbortController().signal);
      expect(result.operations[0].path).toMatch(/^\/el-btn-\d\/clicked$/);
    }
  });

  it('returns empty operations when no clickable paths exist', async () => {
    const schema: OperationSchema = {
      allowedPaths: ['/el-input-0/value', '/el-textarea-1/value'],
      allowedOperations: ['replace'],
      description: 'No buttons',
    };
    const result = await strategy.decide(schema, [], new AbortController().signal);
    expect(result.operations).toHaveLength(0);
    expect(result.reasoning).toContain('No clickable');
  });

  it('returns empty when signal is already aborted', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const result = await strategy.decide(baseSchema, [], aborted.signal);
    expect(result.operations).toHaveLength(0);
    expect(result.reasoning).toContain('Aborted');
  });

  it('handles empty allowedPaths gracefully', async () => {
    const schema: OperationSchema = {
      allowedPaths: [],
      allowedOperations: [],
      description: 'Empty',
    };
    const result = await strategy.decide(schema, [], new AbortController().signal);
    expect(result.operations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LLMStrategy
// ---------------------------------------------------------------------------

describe('LLMStrategy', () => {
  let strategy: LLMStrategy;

  beforeEach(() => {
    strategy = new LLMStrategy();
  });

  it('returns a name', () => {
    expect(strategy.name).toBe('llm-ollama');
  });

  it('rejects when ollama is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('fetch failed'));

    await expect(
      strategy.decide(
        { allowedPaths: [], allowedOperations: [], description: '' },
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow('fetch failed');

    vi.restoreAllMocks();
  });

  it('parses a valid ollama response into operations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            reasoning: 'Click the first button.',
            operations: [
              { op: 'replace', path: '/el-btn-0/clicked', value: true },
            ],
          }),
        },
      }),
    } as Response);

    const result = await strategy.decide(
      {
        allowedPaths: ['/el-btn-0/clicked'],
        allowedOperations: ['replace'],
        description: 'Test',
      },
      ['One button found'],
      new AbortController().signal,
    );

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].path).toBe('/el-btn-0/clicked');
    expect(result.reasoning).toBe('Click the first button.');

    vi.restoreAllMocks();
  });

  it('filters out /complete paths from operations', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            reasoning: 'Task is done.',
            operations: [
              { op: 'replace', path: '/complete', value: 'Task finished' },
            ],
          }),
        },
      }),
    } as Response);

    const result = await strategy.decide(
      {
        allowedPaths: [],
        allowedOperations: [],
        description: 'Test',
      },
      [],
      new AbortController().signal,
    );

    expect(result.operations).toHaveLength(0);
    expect(result.reasoning).toBe('Task is done.');

    vi.restoreAllMocks();
  });
});
