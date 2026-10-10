// eval-spike: Arize Phoenix / Pydantic Logfire (OTel) as the steerability gate.
//
// The grading here is TRACE-BASED: the mock agent loop emits a trace, and the
// evaluator scores one span out of it. That is a different posture from a
// dataset runner — nobody hands you (input, expected, actual). You emit
// telemetry, then you go FIND the decision in it, which is exactly how
// multi-step goal pursuit will have to be scored once a turn stops being the
// unit of work.
//
// Everything below runs with no collector, no container and no token: the
// scoring path is pure OTel SDK + an in-memory exporter. Point
// PHOENIX_COLLECTOR_ENDPOINT at a running Phoenix and the identical spans also
// ship there for a human to look at.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnnotatorKind,
  OpenInferenceSpanKind,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { deterministicBrain, makeRandomBrain, type Brain } from '../evals/brains';
import {
  CASE_ID_ATTRIBUTE,
  DECISION_SPAN_NAME,
  PROJECT_SPAN_NAME,
  TURN_SPAN_NAME,
  runTurn,
  runTurnWithLogfire,
} from '../evals/instrumented-loop';
import {
  createTraceHarness,
  LOGFIRE_SCOPE,
  PHOENIX_ENDPOINT_ENV,
  type TraceHarness,
} from '../evals/otel-harness';
import {
  decisionSpans,
  gradeTrace,
  METRIC_NAME,
  toPhoenixSpanAnnotations,
} from '../evals/span-grader';
import { steerabilityCases } from '../evals/steerability';

let harness: TraceHarness;

beforeEach(async () => {
  harness = await createTraceHarness('aristodromos-steerability', {});
});

afterEach(async () => {
  await harness.shutdown();
});

/** Run the whole fixture through the instrumented loop and grade the trace. */
const runSuite = (brain: Brain, model: string) => {
  for (const testCase of steerabilityCases) {
    runTurn({ tracer: harness.tracer, model }, brain, testCase);
  }
  return gradeTrace(harness.finishedSpans(), steerabilityCases);
};

describe('OTel trace -> span-level steerability grading', () => {
  it('emits a three-span turn with the decision as a DECISION span', () => {
    const [first] = steerabilityCases;
    runTurn({ tracer: harness.tracer, model: 'mock:deterministic' }, deterministicBrain, first);

    const spans = harness.finishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(
      [DECISION_SPAN_NAME, PROJECT_SPAN_NAME, TURN_SPAN_NAME].sort(),
    );

    // All three share one trace, and the graded span is identified by KIND.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const [decision] = decisionSpans(spans);
    expect(decision.name).toBe(DECISION_SPAN_NAME);
    expect(decision.attributes[SemanticConventions.DECISION_MODEL_NAME]).toBe(
      'mock:deterministic',
    );
    expect(decision.attributes[CASE_ID_ATTRIBUTE]).toBe(first.id);
  });

  it('keeps ground truth OFF the span — the answer key lives in the dataset', () => {
    const [first] = steerabilityCases;
    runTurn({ tracer: harness.tracer, model: 'mock:deterministic' }, deterministicBrain, first);

    const [decision] = decisionSpans(harness.finishedSpans());
    const serialized = JSON.stringify(decision.attributes);

    // What the brain CHOSE is on the span, and so is the menu it chose from —
    // the distractor has to be offered or the case tests nothing.
    expect(decision.attributes[SemanticConventions.OUTPUT_VALUE]).toBe(
      JSON.stringify({ actionId: first.correctActionId, confidence: 1 }),
    );
    expect(serialized).toContain(first.distractorActionId);

    // What is NOT on the span: which of them was right, and why the trap is a
    // trap. A span carrying its own answer key would be grading itself.
    expect(serialized).not.toContain(first.trap);
    expect(Object.keys(decision.attributes).join()).not.toMatch(/correct|expected/);

    // Proof by construction: with no dataset there is nothing to score.
    expect(gradeTrace(harness.finishedSpans(), []).evaluations).toEqual([]);
  });

  it('PASSES the deterministic brain 3/3', () => {
    const report = runSuite(deterministicBrain, 'mock:deterministic');

    expect(report.evaluations).toHaveLength(steerabilityCases.length);
    expect(report.missing).toEqual([]);
    expect(report.evaluations.every((e) => e.label === 'correct')).toBe(true);
    expect(report.mean).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('FAILS the random brain — the gate discriminates, it does not rubber-stamp', () => {
    const report = runSuite(makeRandomBrain(1), 'mock:random');

    expect(report.mean).toBeLessThan(1);
    expect(report.passed).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
  });

  it('separates "steered by the page" from merely wrong', () => {
    // Seeded, so this is an assertion and not a hope: with this seed the random
    // brain walks into the distractor on at least one case.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const labels = seeds.flatMap((seed) => {
      harness.reset();
      return runSuite(makeRandomBrain(seed), 'mock:random').evaluations.map((e) => e.label);
    });

    expect(labels).toContain('distractor');
    expect(labels).toContain('wrong');
    expect(new Set(labels).size).toBeGreaterThan(1);
  });
});

describe('span selection is the hazard a dataset runner does not have', () => {
  it('a naive "last span wins" grader scores the projector, not the decision', () => {
    const [first] = steerabilityCases;
    runTurn({ tracer: harness.tracer, model: 'mock:deterministic' }, deterministicBrain, first);

    const spans = harness.finishedSpans();
    const naive = [...spans]
      .reverse()
      .find((s) => typeof s.attributes[SemanticConventions.OUTPUT_VALUE] === 'string');

    // `scene.project` carries an `output.value` too. Grading by position or by
    // "the span that has an output" is wrong here and silently so.
    expect(naive?.name).toBe(TURN_SPAN_NAME);
    expect(naive?.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(
      OpenInferenceSpanKind.CHAIN,
    );
    expect(decisionSpans(spans)[0].name).toBe(DECISION_SPAN_NAME);
  });

  it('a missing decision span FAILS the gate instead of shrinking the denominator', () => {
    // Instrument only two of the three cases — the shape of a real
    // instrumentation regression, where the loop still runs and the span is
    // simply never emitted.
    for (const testCase of steerabilityCases.slice(0, 2)) {
      runTurn({ tracer: harness.tracer, model: 'mock:deterministic' }, deterministicBrain, testCase);
    }

    const report = gradeTrace(harness.finishedSpans(), steerabilityCases);

    expect(report.evaluations.every((e) => e.score === 1)).toBe(true);
    expect(report.mean).toBe(1); // every span that WAS graded passed...
    expect(report.missing).toEqual([steerabilityCases[2].id]); // ...and the gate still fails.
    expect(report.passed).toBe(false);
    expect(report.failures[0]).toContain('NO DECISION SPAN');
  });

  it('collapses repeated turns for one case — the single-tick assumption, made visible', () => {
    const [first] = steerabilityCases;
    // Two ticks on the same case: wrong first, right second. A trajectory
    // metric would call this "recovered"; this grader keeps only the last.
    runTurn({ tracer: harness.tracer, model: 'mock:random' }, makeRandomBrain(1), first);
    runTurn({ tracer: harness.tracer, model: 'mock:deterministic' }, deterministicBrain, first);

    const spans = harness.finishedSpans();
    expect(decisionSpans(spans)).toHaveLength(2);

    const report = gradeTrace(spans, [first]);
    expect(report.evaluations).toHaveLength(1);
    expect(report.evaluations[0].chosen).toBe(first.correctActionId);

    // This is the ceiling of a per-choice metric, not a bug in the trace: the
    // telemetry holds both ticks, and only the GRADER throws one away. Scoring
    // multi-step goal pursuit means keying on (case, tick) and asking a
    // different question — which is the whole argument for the span seat.
  });
});

describe('Logfire and Phoenix are two backends for one instrumentation', () => {
  it('grades a logfire-api-emitted trace with the identical evaluator', () => {
    for (const testCase of steerabilityCases) {
      runTurnWithLogfire('mock:deterministic', deterministicBrain, testCase);
    }

    const spans = harness.finishedSpans();
    // logfire-api resolves its tracer from the GLOBAL OTel API, so its spans
    // land in the same in-memory exporter under the `logfire` scope.
    expect(spans.every((s) => s.instrumentationScope.name === LOGFIRE_SCOPE)).toBe(true);
    expect(spans).toHaveLength(steerabilityCases.length * 3);

    const report = gradeTrace(spans, steerabilityCases);
    expect(report.mean).toBe(1);
    expect(report.passed).toBe(true);
  });

  it('logfire renames the span but leaves the OpenInference attributes alone', () => {
    const [first] = steerabilityCases;
    runTurnWithLogfire('mock:deterministic', deterministicBrain, first);

    const [decision] = decisionSpans(harness.finishedSpans());

    // Logfire names a span after its MESSAGE TEMPLATE, so selecting by
    // `span.name === 'decide'` would find nothing here. Selecting by
    // `openinference.span.kind` survives the backend swap; selecting by name
    // does not.
    expect(decision.name).toBe('decide {aristodromos.case.id}');
    expect(decision.attributes['logfire.msg_template']).toBe('decide {aristodromos.case.id}');
    expect(decision.attributes['logfire.msg']).toBe(`decide ${first.id}`);
    expect(decision.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(
      OpenInferenceSpanKind.DECISION,
    );
    expect(decision.attributes[SemanticConventions.OUTPUT_VALUE]).toBe(
      JSON.stringify({ actionId: first.correctActionId, confidence: 1 }),
    );
  });
});

describe('the Phoenix integration surface', () => {
  it('renders evaluations as span annotations keyed by span id', () => {
    const report = runSuite(makeRandomBrain(1), 'mock:random');
    const annotations = toPhoenixSpanAnnotations(report.evaluations);

    expect(annotations).toHaveLength(steerabilityCases.length);
    for (const annotation of annotations) {
      expect(annotation.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(annotation.name).toBe(METRIC_NAME);
      expect(annotation.annotator_kind).toBe(AnnotatorKind.CODE);
      expect(annotation.result.explanation.length).toBeGreaterThan(0);
    }

    const graded = new Set(report.evaluations.map((e) => e.spanId));
    const emitted = new Set(decisionSpans(harness.finishedSpans()).map((s) => s.spanContext().spanId));
    expect([...graded].every((id) => emitted.has(id))).toBe(true);
  });

  it('runs hermetically: the live exporter is opt-in', async () => {
    expect(harness.live).toBe(false);

    const configured = await createTraceHarness('probe', {
      [PHOENIX_ENDPOINT_ENV]: 'http://localhost:6006',
    });
    expect(configured.live).toBe(true);
    await configured.shutdown();
  });
});
