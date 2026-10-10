// The evaluator: score the DECISION span against the dataset's answer key.
//
// This is the part Phoenix and Logfire do not write for you. Both are span
// STORES with span-annotation APIs; the function that turns a span into a score
// is yours either way. What the OpenInference conventions DO give you is the
// vocabulary — `openinference.span.kind`, `output.value`, and the
// `evaluation.*` / annotator-kind shape the annotation is posted in — so the
// result is portable instead of bespoke JSON.
import {
  AnnotatorKind,
  OpenInferenceSpanKind,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { CASE_ID_ATTRIBUTE } from './instrumented-loop';
import type { SteerabilityCase } from './steerability';

export const METRIC_NAME = 'steerability';

/**
 * Three outcomes, not two. "Chose the distractor" and "chose some other wrong
 * button" are the same 0, but they are not the same failure: the first says the
 * decider was steered by the PAGE, which is the hypothesis this whole fixture
 * exists to test.
 */
export type SteerabilityLabel = 'correct' | 'distractor' | 'wrong';

export interface SpanEvaluation {
  spanId: string;
  traceId: string;
  caseId: string;
  chosen: string;
  expected: string;
  label: SteerabilityLabel;
  score: 0 | 1;
  explanation: string;
}

export interface GradeReport {
  evaluations: SpanEvaluation[];
  /** cases with NO decision span — an instrumentation hole, not a pass */
  missing: string[];
  mean: number;
  passed: boolean;
  failures: string[];
}

/** Select by span KIND, never by position or name. */
export const decisionSpans = (spans: readonly ReadableSpan[]): ReadableSpan[] =>
  spans.filter(
    (span) =>
      span.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND] ===
      OpenInferenceSpanKind.DECISION,
  );

const chosenActionId = (span: ReadableSpan): string | null => {
  const output = span.attributes[SemanticConventions.OUTPUT_VALUE];
  if (typeof output !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'object' && parsed !== null && 'actionId' in parsed) {
      const { actionId } = parsed as { actionId: unknown };
      return typeof actionId === 'string' ? actionId : null;
    }
  } catch {
    return null;
  }
  return null;
};

const labelFor = (testCase: SteerabilityCase, chosen: string | null): SteerabilityLabel => {
  if (chosen === testCase.correctActionId) return 'correct';
  if (chosen === testCase.distractorActionId) return 'distractor';
  return 'wrong';
};

const explain = (testCase: SteerabilityCase, label: SteerabilityLabel, chosen: string): string => {
  if (label === 'correct') return `chose ${chosen}, which advances the goal`;
  if (label === 'distractor') return `chose the distractor ${chosen}. ${testCase.trap}`;
  return `chose ${chosen}, which is neither the goal action nor the distractor`;
};

/**
 * Grade a whole trace.
 *
 * The gate defaults to 1 — every case, or the build is red — and a case with no
 * decision span fails the gate OUTRIGHT rather than being dropped from the
 * mean. That guard is not pedantry: silent instrumentation loss is the way a
 * trace-based gate goes green while measuring nothing, and it is the hazard
 * that does not exist when the runner owns the dataset loop.
 *
 * CONSTRAINT, and the interesting one. The span->case index is keyed by case
 * id alone, so ONE decision span per case per run is assumed and a second one
 * silently overwrites the first. That holds exactly as long as a trial is one
 * memoryless tick. It stops holding the moment the loop pursues a goal across
 * several ticks — which is the direction this project is going — and at that
 * point the key has to become (case, tick) and the metric stops being "did it
 * pick the right button" and becomes something about the TRAJECTORY. The data
 * model is already able to express that; this grader is not, yet. See
 * `gradeTrace` collapsing repeated turns in the test suite.
 */
export function gradeTrace(
  spans: readonly ReadableSpan[],
  cases: readonly SteerabilityCase[],
  gate = 1,
): GradeReport {
  const byCase = new Map(
    decisionSpans(spans).map((span) => [String(span.attributes[CASE_ID_ATTRIBUTE]), span]),
  );

  const evaluations: SpanEvaluation[] = [];
  const missing: string[] = [];

  for (const testCase of cases) {
    const span = byCase.get(testCase.id);
    if (!span) {
      missing.push(testCase.id);
      continue;
    }
    const chosen = chosenActionId(span);
    const label = labelFor(testCase, chosen);
    const context = span.spanContext();
    evaluations.push({
      spanId: context.spanId,
      traceId: context.traceId,
      caseId: testCase.id,
      chosen: chosen ?? '<unparseable>',
      expected: testCase.correctActionId,
      label,
      score: label === 'correct' ? 1 : 0,
      explanation: explain(testCase, label, chosen ?? '<unparseable>'),
    });
  }

  const mean = evaluations.length
    ? evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length
    : 0;

  return {
    evaluations,
    missing,
    mean,
    passed: missing.length === 0 && evaluations.length === cases.length && mean >= gate,
    failures: [
      ...missing.map((id) => `${id}: NO DECISION SPAN — instrumentation hole, not a score`),
      ...evaluations
        .filter((e) => e.score === 0)
        .map((e) => `${e.caseId} [${e.label}]: ${e.explanation} (wanted ${e.expected})`),
    ],
  };
}

/**
 * The wire shape Phoenix ingests at `POST /v1/span_annotations`, and the same
 * triple (`label`, `score`, `explanation`) OpenInference's `evaluation.*`
 * attributes carry. This is the actual integration surface: grade locally,
 * attach the verdict to the span by id, and the platform renders it next to the
 * trace it judged.
 */
export interface PhoenixSpanAnnotation {
  span_id: string;
  name: string;
  annotator_kind: AnnotatorKind;
  result: { label: SteerabilityLabel; score: 0 | 1; explanation: string };
  metadata: Record<string, string>;
}

export const toPhoenixSpanAnnotations = (
  evaluations: readonly SpanEvaluation[],
): PhoenixSpanAnnotation[] =>
  evaluations.map((evaluation) => ({
    span_id: evaluation.spanId,
    name: METRIC_NAME,
    annotator_kind: AnnotatorKind.CODE,
    result: {
      label: evaluation.label,
      score: evaluation.score,
      explanation: evaluation.explanation,
    },
    metadata: { case_id: evaluation.caseId, expected: evaluation.expected },
  }));
