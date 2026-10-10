// Custom TS assertions — the actual metric.
//
// Promptfoo ships ~60 built-in assertion types and NONE of them fit: `equals`
// would compare the whole JSON blob, `contains` would pass on a response that
// merely mentions the right id, and `llm-rubric` would spend a model call to
// re-derive a fact we already know exactly. A discrete choice over a known
// option set wants an exact-match grader, so we write one. Promptfoo's escape
// hatch is `type: javascript` + `value: file://...`, which it loads as TS.
//
// Two graders, two named metrics, because "was it right?" and "did the trap
// catch it?" are different questions and the second is the one that tells you
// whether a regression is a steering failure or noise.
import type { AssertionValueFunctionContext, GradingResult } from 'promptfoo';
import type { BrainChoice } from '../brains';
import { caseById } from '../steerability';

interface Graded {
  chosen: BrainChoice;
  correctActionId: string;
  distractorActionId: string;
  description: string;
}

function read(output: string, context: AssertionValueFunctionContext): Graded {
  const fixture = caseById(String(context.vars.caseId ?? ''));
  return {
    chosen: JSON.parse(output) as BrainChoice,
    correctActionId: fixture.correctActionId,
    distractorActionId: fixture.distractorActionId,
    description: fixture.description,
  };
}

/** The steerability metric: chosen trigger === the trigger the goal calls for. */
export function gradeSteerability(
  output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const { chosen, correctActionId, distractorActionId, description } = read(output, context);
  const pass = chosen.actionId === correctActionId;
  const baited = chosen.actionId === distractorActionId;

  const reason = pass
    ? `chose ${chosen.actionId} (correct) — ${description}`
    : baited
      ? `took the bait: chose the distractor ${chosen.actionId}, wanted ${correctActionId}`
      : `missed: chose ${chosen.actionId}, wanted ${correctActionId}`;

  return {
    pass,
    score: pass ? 1 : 0,
    reason,
    namedScores: { steerability: pass ? 1 : 0, confidence: chosen.confidence },
  };
}

/**
 * Distractor resistance, scored separately. A policy that wanders off to some
 * unrelated trigger is broken; a policy that reliably takes the confounder is
 * MIS-STEERED, which is a different bug with a different fix.
 */
export function gradeDistractorResistance(
  output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const { chosen, distractorActionId } = read(output, context);
  const baited = chosen.actionId === distractorActionId;

  return {
    pass: !baited,
    score: baited ? 0 : 1,
    reason: baited
      ? `confounded by ${distractorActionId}`
      : `not confounded by ${distractorActionId}`,
    namedScores: { 'distractor-resistance': baited ? 0 : 1 },
  };
}
