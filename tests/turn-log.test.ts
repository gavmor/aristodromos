import { describe, expect, it } from 'vitest';
import { type LoggedTurn, turnsOf, verifiedRowsOf, withOutcome } from '../utils/turn-log';

const choice = (pick: string) => ({ type: 'choice', choice: pick, probabilities: { [pick]: 0.9 }, confidence: 0.9 });
const evidence = {
  request: {
    model: 'm',
    state: 'goal: g\n\nobservation:\n(page)',
    questions: {
      next_action: { type: 'choice', instructions: 'next?', criteria: { click_go: 'Go' } },
      goal_reached: { type: 'noul', instructions: 'done?' },
    },
  },
  response: { model: 'm', answers: { next_action: choice('click_go'), goal_reached: { type: 'noul', noul: 0.1 } } },
};

const turn = (tabId: number, documentId: string, tick: number, at: number): LoggedTurn => ({
  tabId,
  documentId,
  tick,
  at,
  url: 'https://example.test/',
  opsSinceLastTurn: 0,
  afforded: { state: [], trigger: [] },
  satisfied: '',
  remaining: '',
  actions: [{ kind: 'clickTrigger', nodeId: 'f0.go' }],
  ms: 1,
  via: 'system-one',
  evidence,
});

describe('withOutcome', () => {
  it('marks the turn of that tab, document and tick, not a same-tick turn elsewhere', () => {
    const log = [turn(1, 'a', 1, 1), turn(2, 'a', 1, 2), turn(1, 'b', 1, 3)];
    const next = withOutcome(log, 1, { tick: 1, documentId: 'b', moved: true });
    expect(next.map((t) => t.moved)).toEqual([undefined, undefined, true]);
  });

  it('leaves the log as is when the turn has already been rotated out', () => {
    const log = [turn(1, 'a', 1, 1)];
    expect(withOutcome(log, 1, { tick: 9, documentId: 'a', moved: true })).toBe(log);
  });
});

describe('verifiedRowsOf', () => {
  it('rows from the moved turns of one tab only', () => {
    const log = withOutcome([turn(1, 'a', 1, 1), turn(2, 'a', 1, 2)], 1, { tick: 1, documentId: 'a', moved: true });
    const rows = verifiedRowsOf(log, 1, 'run');
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ['run-1', 'click_go'],
      ['run-2', 'no'],
    ]);
    expect(verifiedRowsOf(log, 2, 'run')).toEqual([]);
  });
});

describe('turnsOf', () => {
  it('reads nothing malformed from storage', () => {
    expect(turnsOf(undefined)).toEqual([]);
    expect(turnsOf([null, 3, { tick: 1 }, turn(1, 'a', 1, 1)])).toHaveLength(1);
  });
});
