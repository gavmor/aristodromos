import { describe, it, expect } from 'vitest';
import { decideSceneTransition, recordMemory } from '../utils/bg-handler';

describe('decideSceneTransition', () => {
  const baseScene = {
    newInformation: ['Observed 3 interactive elements'],
    affordances: {
      'el-btn-0': { role: 'button' as const },
      'el-input-1': { role: 'textbox' as const },
    },
  };

  it('returns "act" when idle and scene has affordances', () => {
    const result = decideSceneTransition(baseScene, 'idle', false);
    expect(result.transition).toBe('act');
    expect(result.isComplete).toBe(false);
    expect(result.status).toBe('acting');
  });

  it('returns "complete" when a button has value=true', () => {
    const scene = {
      ...baseScene,
      affordances: {
        'el-btn-0': { role: 'button' as const, value: true },
      },
    };
    const result = decideSceneTransition(scene, 'acting', true);
    expect(result.transition).toBe('complete');
    expect(result.isComplete).toBe(true);
    expect(result.status).toBe('terminated');
  });

  it('returns "abort" when acting and previous AI loop exists', () => {
    const result = decideSceneTransition(baseScene, 'acting', true);
    expect(result.transition).toBe('abort');
    expect(result.isComplete).toBe(false);
  });

  it('returns "noop" when already terminated', () => {
    const result = decideSceneTransition(baseScene, 'terminated', false);
    expect(result.transition).toBe('noop');
    expect(result.isComplete).toBe(true);
  });

  it('handles empty affordances', () => {
    const scene = { newInformation: [], affordances: {} };
    const result = decideSceneTransition(scene, 'idle', false);
    expect(result.transition).toBe('act');
    expect(result.isComplete).toBe(false);
  });
});

describe('recordMemory', () => {
  it('appends a new memory entry', () => {
    const result = recordMemory(['first'], 'second');
    expect(result).toEqual(['first', 'second']);
  });

  it('trims to max length', () => {
    const entries = Array.from({ length: 5 }, (_, i) => `mem-${i}`);
    const result = recordMemory(entries, 'overflow', 3);
    expect(result).toEqual(['mem-3', 'mem-4', 'overflow']);
  });
});
