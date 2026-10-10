// The MOCK agent loop, instrumented — the thing under trace.
//
// A turn is deliberately THREE spans, not one:
//
//   agent.turn      CHAIN     the tick
//     scene.project TOOL      the projector (mocked) — a decoy that also
//                             carries an `output.value`
//     decide        DECISION  the brain's choice: the span that gets graded
//
// A flat dataset runner hands the grader (input, output, expected) and the
// question "which output?" never arises. Here it does, and SPAN SELECTION is
// the first thing a trace-based harness makes you get right: `scene.project`
// has an output too, and grading it would score node counts against action ids
// forever, silently.
//
// `decide` is an OpenInference DECISION span, which is not a flourish: the spec
// defines DECISION for exactly this shape — "state plus typed questions returns
// a typed, structured answer" — which is what utils/brain.ts does with a
// Scene-derived zod schema. The eval therefore describes the real system, not a
// test-only shim.
import { context, trace, type Context, type Span, type Tracer } from '@opentelemetry/api';
import {
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import * as logfire from '@pydantic/logfire-api';
import type { Brain, BrainChoice } from './brains';
import { offeredActions, type SteerabilityCase } from './steerability';

export const TURN_SPAN_NAME = 'agent.turn';
export const PROJECT_SPAN_NAME = 'scene.project';
export const DECISION_SPAN_NAME = 'decide';

/**
 * The join key from a span back to its dataset row.
 *
 * OpenInference has `session.id`, `user.id` and `metadata` — and nothing for
 * "which dataset example produced this span". So the key is bespoke, and every
 * grader in this repo has to agree on it by convention. That is the structural
 * cost of grading a TRACE instead of a table: the dataset link is not in the
 * protocol, it is in your head.
 */
export const CASE_ID_ATTRIBUTE = 'aristodromos.case.id';

/** Attributes of the span that gets graded. Shared by both emitters. */
export const decisionAttributes = (
  testCase: SteerabilityCase,
  choice: BrainChoice,
  model: string,
): Record<string, string | number> => ({
  [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.DECISION,
  [SemanticConventions.DECISION_MODEL_NAME]: model,
  [SemanticConventions.INPUT_VALUE]: JSON.stringify({
    goal: testCase.goal,
    offered: offeredActions(testCase.scene),
  }),
  [SemanticConventions.INPUT_MIME_TYPE]: MimeType.JSON,
  // The grader parses THIS. Note what is absent: `correctActionId`. Ground
  // truth lives in the dataset, never on the span — a span that carried its own
  // answer key would be grading itself.
  [SemanticConventions.OUTPUT_VALUE]: JSON.stringify(choice),
  [SemanticConventions.OUTPUT_MIME_TYPE]: MimeType.JSON,
  [CASE_ID_ATTRIBUTE]: testCase.id,
});

const turnAttributes = (testCase: SteerabilityCase): Record<string, string> => ({
  [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
  [SemanticConventions.SESSION_ID]: testCase.id,
  [SemanticConventions.INPUT_VALUE]: testCase.goal,
  [CASE_ID_ATTRIBUTE]: testCase.id,
});

/** The decoy. Shaped like the real projector's up-edge: a Scene, not a choice. */
const projectionAttributes = (testCase: SteerabilityCase): Record<string, string | number> => ({
  [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
  [SemanticConventions.TOOL_NAME]: 'scene-projector',
  [SemanticConventions.OUTPUT_VALUE]: JSON.stringify({
    documentId: testCase.scene.documentId,
    nodes: Object.keys(testCase.scene.nodes).length,
  }),
  [SemanticConventions.OUTPUT_MIME_TYPE]: MimeType.JSON,
  [CASE_ID_ATTRIBUTE]: testCase.id,
});

export interface TurnOptions {
  tracer: Tracer;
  /** what `decision.model_name` reports — here, which mock brain ran */
  model: string;
}

/**
 * Emit one child span under an EXPLICIT parent context.
 *
 * Not `startActiveSpan`. OTel's implicit parenting rides on a ContextManager,
 * and there is none here — nor is there a good one where this code actually
 * runs: an MV3 service worker has no AsyncLocalStorage, and the content script
 * has only the sync-stack manager. Measured: with no ContextManager registered,
 * `startActiveSpan` produces three UNRELATED root traces instead of one turn,
 * and a grader that walks a trace would see three traces of one span each.
 * Threading the context by hand is the portable fix and costs one argument.
 */
const childSpan = (
  tracer: Tracer,
  name: string,
  parent: Context,
  attributes: Record<string, string | number>,
): void => {
  const span = tracer.startSpan(name, undefined, parent);
  span.setAttributes(attributes);
  span.end();
};

/** One instrumented tick, via the plain OTel API. */
export function runTurn(
  options: TurnOptions,
  brain: Brain,
  testCase: SteerabilityCase,
): BrainChoice {
  const { tracer, model } = options;
  const turn: Span = tracer.startSpan(TURN_SPAN_NAME);
  turn.setAttributes(turnAttributes(testCase));
  const within = trace.setSpan(context.active(), turn);

  try {
    childSpan(tracer, PROJECT_SPAN_NAME, within, projectionAttributes(testCase));

    const choice = brain(testCase, testCase.goal);
    childSpan(tracer, DECISION_SPAN_NAME, within, decisionAttributes(testCase, choice, model));

    turn.setAttribute(SemanticConventions.OUTPUT_VALUE, choice.actionId);
    return choice;
  } finally {
    turn.end();
  }
}

/**
 * The same tick through `@pydantic/logfire-api`.
 *
 * Same spans, same attributes, same grader — the only differences are the call
 * syntax, the `logfire.*` attributes it adds, and that the span NAME becomes
 * the message template. There is no Logfire runtime here and no token:
 * `logfire-api` is a facade over the global OTel tracer, so it writes into
 * whatever provider `createTraceHarness` registered. Nothing about the eval
 * changes when the backend does.
 *
 * `parentSpan` is the explicit-context escape hatch again: Logfire's nesting
 * has the same ContextManager dependency, and the same one-argument fix.
 */
export function runTurnWithLogfire(
  model: string,
  brain: Brain,
  testCase: SteerabilityCase,
): BrainChoice {
  return logfire.span(
    'turn {aristodromos.case.id}',
    turnAttributes(testCase),
    {},
    (turn: Span) => {
      logfire.span(
        'project {aristodromos.case.id}',
        projectionAttributes(testCase),
        { parentSpan: turn },
        () => undefined,
      );
      const choice = brain(testCase, testCase.goal);
      logfire.span(
        'decide {aristodromos.case.id}',
        decisionAttributes(testCase, choice, model),
        { parentSpan: turn },
        () => undefined,
      );
      return choice;
    },
  );
}
