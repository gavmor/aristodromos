// The turn log as stored under TURN_LOG_KEY: every tab's turns, each stamped
// with its tab and, once the page has answered its plan, whether it moved.
//
// Pure, so the background, the panel and the e2e runner share one reading of
// it and tests drive it without a browser.
import type { TurnOutcome, TurnRecord } from '@gavmor/skene/core';
import { type TrainingRow, trainingRowsOf } from '@gavmor/skene/training';

export interface LoggedTurn extends TurnRecord {
  /** absent until the page answers the turn's plan, and for good if it never does */
  moved?: boolean;
}

/** The log with one turn's outcome recorded. Turns are keyed by tab, document and tick: ticks restart per document. */
export function withOutcome(log: LoggedTurn[], tabId: number, outcome: TurnOutcome): LoggedTurn[] {
  const at = log.findLastIndex(
    (turn) => turn.tabId === tabId && turn.documentId === outcome.documentId && turn.tick === outcome.tick,
  );
  if (at < 0) return log;
  return log.with(at, { ...log[at], moved: outcome.moved });
}

/** Turns from storage, keeping only entries that look like turns. */
export function turnsOf(stored: unknown): LoggedTurn[] {
  return Array.isArray(stored)
    ? stored.filter((t): t is LoggedTurn => typeof t === 'object' && t !== null && 'tick' in t && 'documentId' in t)
    : [];
}

/**
 * Training rows from one tab's logged turns, on the caller's word that the
 * run succeeded: a passing test's post-condition, or a person who watched it.
 * Nothing in the log can vouch for that itself.
 */
export function verifiedRowsOf(log: LoggedTurn[], tabId: number, runId: string): TrainingRow[] {
  const turns = log.filter((turn) => turn.tabId === tabId);
  const outcomes = turns.flatMap((turn): TurnOutcome[] =>
    turn.moved === undefined ? [] : [{ tick: turn.tick, documentId: turn.documentId, moved: turn.moved }],
  );
  return trainingRowsOf({ id: runId, verified: true, turns, outcomes });
}
