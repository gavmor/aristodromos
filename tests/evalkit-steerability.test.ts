// @vitest-environment node
//
// eval-spike: EvalKit (@evalkit/core@0.0.2) as a steerability gate.
//
// The question is narrow: can EvalKit express "the policy chose the goal-correct
// action out of the ones the Scene offered, and not the prominent decoy?" —
// and can that expression FAIL a build?
//
// This file answers it by running the thing, not by reading its README. Each
// test below is a finding; EVAL-SPIKE-FINDINGS.md is the write-up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as evalkit from '@evalkit/core';
import {
  IntentClassificationMetric,
  evaluate,
  type EvaluationExecutionReport,
} from '@evalkit/core';
import {
  actionLabel,
  deterministicBrain,
  makeRandomBrain,
  offeredActions,
  randomBrain,
  type Brain,
} from './eval/brains';
import { STEERABILITY_CASES } from './eval/steerability-cases';
import { startFakeJudge, type FakeJudge } from './eval/fake-openai';

interface Graded {
  caseId: string;
  chosen: string;
  expected: string;
  passed: boolean;
  tookConfounder: boolean;
}

function grade(brain: Brain): Graded[] {
  return STEERABILITY_CASES.map((testCase) => {
    const decision = brain(testCase.scene, testCase.goal);
    return {
      caseId: testCase.id,
      chosen: decision.actionId,
      expected: testCase.correctActionId,
      passed: decision.actionId === testCase.correctActionId,
      tookConfounder: decision.actionId === testCase.confounderActionId,
    };
  });
}

const passRate = (rows: Graded[]) => rows.filter((r) => r.passed).length / rows.length;

/**
 * The published report.service.d.ts declares `getFinalResult()`; the published
 * index.esm.js implements `getFinalReport()`. The types are wrong, so reaching
 * the real method needs a shim. Asserted as a finding further down.
 */
const reportsOf = (service: evalkit.ReportService) =>
  service as unknown as { getFinalReport(): EvaluationExecutionReport };

/** What a discrete-choice steerability metric would need to carry. */
interface ChoiceParams {
  chosenActionId: string;
  correctActionId: string;
  offeredActionIds: string[];
}

/**
 * The extension attempt, kept at module scope so tsc judges it on every commit.
 * BaseMetric is not exported, so the only reachable base is a concrete
 * generation-quality metric — and its param type cannot be narrowed.
 */
class ActionChoiceMetric extends IntentClassificationMetric {
  // @ts-expect-error TS2416 — `evaluationParams` is invariant through the class
  // hierarchy, so no subclass may re-type it. This is the wall.
  declare evaluationParams: ChoiceParams;

  constructor(params: ChoiceParams) {
    // The super call is pure ceremony: it builds an OpenAI client we never use.
    super({ input: params.chosenActionId, expectedIntents: [params.correctActionId] });
    this.evaluationParams = params;
  }

  override async evaluateSteps() {
    const { chosenActionId, correctActionId } = this.evaluationParams;
    return {
      score: chosenActionId === correctActionId ? 1 : 0,
      reasons: [`chose ${chosenActionId}, wanted ${correctActionId}`],
    };
  }
}

// ---------------------------------------------------------------------------
// 1. The reference gate: what this eval needs, written without EvalKit.
//    Included so the EvalKit sections have something to be compared against.
// ---------------------------------------------------------------------------
describe('reference gate (plain Vitest, zero dependencies)', () => {
  it('passes the perfectly-steered brain 3/3', () => {
    const rows = grade(deterministicBrain);
    expect(rows.map((r) => r.chosen)).toEqual(STEERABILITY_CASES.map((c) => c.correctActionId));
    expect(passRate(rows)).toBe(1);
  });

  it('fails the unsteered brain, and the failure names the decoy it fell for', () => {
    const rows = grade(randomBrain);
    expect(passRate(rows)).toBeLessThan(1);
    expect(rows.some((r) => r.tookConfounder)).toBe(true);
  });

  it('discriminates on average, not just on a lucky seed', () => {
    const trials = 300;
    const rates = Array.from({ length: trials }, (_, seed) => passRate(grade(makeRandomBrain(seed))));
    const mean = rates.reduce((a, b) => a + b, 0) / trials;
    // Each case offers exactly three reachable triggers, so blind guessing
    // converges on 1/3. Observed over 300 seeds: 0.347.
    const sizes = STEERABILITY_CASES.map((c) => offeredActions(c.scene).length);
    const chance = sizes.reduce((acc, n) => acc + 1 / n, 0) / sizes.length;
    expect(sizes).toEqual([3, 3, 3]);
    expect(chance).toBeCloseTo(1 / 3, 6);
    expect(mean).toBeCloseTo(chance, 1);
    expect(mean).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 2. EvalKit's closest built-in metric, actually executed.
// ---------------------------------------------------------------------------
describe('EvalKit IntentClassificationMetric on the same decisions', () => {
  let judge: FakeJudge;

  beforeAll(async () => {
    judge = await startFakeJudge();
    // EvalKit offers no way to inject a judge, so the client has to be
    // redirected through the environment before the first metric is built.
    process.env.OPENAI_API_KEY = 'sk-fake-offline';
    process.env.OPENAI_BASE_URL = judge.baseURL;
  });

  afterAll(async () => {
    delete process.env.OPENAI_BASE_URL;
    await judge.close();
  });

  /** The only encoding of a discrete choice the metric's params can carry. */
  const asIntent = (caseIndex: number, actionId: string) =>
    `click ${actionLabel(STEERABILITY_CASES[caseIndex]!.scene, actionId)}`;

  it('cannot be constructed at all without an OpenAI key', () => {
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      // Not a network call — the BaseMetric CONSTRUCTOR builds an OpenAI client.
      expect(() => new IntentClassificationMetric({ input: 'x', expectedIntents: ['x'] })).toThrow(
        /OPENAI_API_KEY/,
      );
    } finally {
      process.env.OPENAI_API_KEY = key;
    }
  });

  it('does separate the right choice from the decoy — but only by string equality', async () => {
    const correct = new IntentClassificationMetric({
      input: asIntent(0, STEERABILITY_CASES[0]!.correctActionId),
      expectedIntents: [asIntent(0, STEERABILITY_CASES[0]!.correctActionId)],
    });
    const decoy = new IntentClassificationMetric({
      input: asIntent(0, STEERABILITY_CASES[0]!.confounderActionId),
      expectedIntents: [asIntent(0, STEERABILITY_CASES[0]!.correctActionId)],
    });

    expect(await correct.executeEvaluation()).toMatchObject({ passed: true, score: 1 });
    expect(await decoy.executeEvaluation()).toMatchObject({ passed: false, score: 0 });

    // What produced that verdict: two chat completions against a hardcoded model.
    expect(judge.calls.map((c) => c.model)).toEqual(['gpt-4o-mini', 'gpt-4o-mini']);
    expect(judge.calls.every((c) => c.path === '/v1/chat/completions')).toBe(true);
  });

  it('never shows the grader the choice set, so the confounder is inexpressible', async () => {
    const [loginCase] = STEERABILITY_CASES;
    const before = judge.calls.length;
    await new IntentClassificationMetric({
      input: asIntent(0, loginCase!.correctActionId),
      expectedIntents: [asIntent(0, loginCase!.correctActionId)],
    }).executeEvaluation();
    const sent = judge.calls.slice(before);
    const transcript = sent.map((c) => `${c.system}\n${c.user}`).join('\n');

    // The decoy the case was built around reaches the judge in no form at all.
    expect(transcript).not.toContain('Subscribe');
    expect(transcript).not.toContain(loginCase!.confounderActionId);
    // Nor do any of the other actions the Scene offered.
    for (const id of offeredActions(loginCase!.scene)) {
      if (id === loginCase!.correctActionId) continue;
      expect(transcript).not.toContain(id);
    }
  });

  it('evaluate() swallows a failing metric instead of failing the run', async () => {
    class ExplodingMetric extends IntentClassificationMetric {
      override async evaluateSteps(): Promise<never> {
        throw new Error('grader exploded');
      }
    }
    const report = await evaluate({ input: 'a', expectedIntents: ['a'] }, [ExplodingMetric]);
    // No throw, no rejected promise, nothing a CI gate can observe: the error
    // was console.error'd inside the executor and the report moved on.
    expect(report).toBeDefined();
    expect(report.items.some((i) => i.result.reasons.includes('grader exploded'))).toBe(false);
  });

  it('ships type declarations that disagree with the shipped JavaScript', () => {
    const service = evalkit.ReportService.getInstance();
    // report.service.d.ts declares getFinalResult(). The bundle has no such method.
    expect('getFinalResult' in service).toBe(false);
    expect(typeof reportsOf(service).getFinalReport).toBe('function');
  });

  it('reports are a process-wide singleton, so per-run scoring is not available', async () => {
    const service = reportsOf(evalkit.ReportService.getInstance());
    const before = service.getFinalReport().items.length;
    const run = await evaluate(
      { input: asIntent(0, 'n-signin'), expectedIntents: [asIntent(0, 'n-signin')] },
      [IntentClassificationMetric],
    );
    // The "report" for this run is the accumulated log of every evaluation the
    // process has ever done, and it aliases live mutable state.
    expect(run.items.length).toBeGreaterThan(1);
    expect(run.items.length).toBe(before + 1);
    expect(run.items).toBe(service.getFinalReport().items);
  });

  it('does not export BaseMetric, so a custom discrete-choice metric has no base', () => {
    expect(Object.keys(evalkit)).not.toContain('BaseMetric');
    // Every public export is a judge-backed generation-quality metric or plumbing.
    expect(Object.keys(evalkit).filter((k) => k.endsWith('Metric')).sort()).toEqual([
      'BiasDetectionMetric',
      'CoherenceMetric',
      'DynamicMetric',
      'FaithfulnessMetric',
      'HallucinationMetric',
      'IntentClassificationMetric',
      'RelevancyMetric',
      'SemanticSimilarityMetric',
    ]);
  });

  // -------------------------------------------------------------------------
  // 3. Forcing a real steerability metric through anyway — what it costs.
  // -------------------------------------------------------------------------
  it('a hand-rolled discrete-choice metric does grade correctly once forced past the types', async () => {
    const run = (brain: Brain) =>
      Promise.all(
        STEERABILITY_CASES.map(async (testCase) => {
          const decision = brain(testCase.scene, testCase.goal);
          const metric = new ActionChoiceMetric({
            chosenActionId: decision.actionId,
            correctActionId: testCase.correctActionId,
            offeredActionIds: offeredActions(testCase.scene),
          });
          return metric.executeEvaluation();
        }),
      );

    const steered = await run(deterministicBrain);
    const unsteered = await run(makeRandomBrain(7));

    expect(steered.every((r) => r.passed)).toBe(true);
    expect(unsteered.some((r) => !r.passed)).toBe(true);
    // …and it reached that verdict without touching the judge, because the
    // override replaced the only part of EvalKit that was doing any work.
    expect(judge.calls.every((c) => c.path === '/v1/chat/completions')).toBe(true);
  });

  it('cannot be handed to evaluate() at all, though it runs fine if you cast', async () => {
    const params: ChoiceParams = {
      chosenActionId: 'n-signin',
      correctActionId: 'n-signin',
      offeredActionIds: ['n-signin', 'n-subscribe'],
    };
    // @ts-expect-error TS2345 — for a metric the library does not know about,
    // `LLMTestCase` collapses to the INTERSECTION of all eight built-in param
    // types, so this call also demands input, expectedIntents, output, context,
    // text1, text2, actualOutput, expectedOutput and criteria. The runtime is
    // happy; only the type surface refuses.
    const report = await evaluate(params, [ActionChoiceMetric]);
    expect(report.items.length).toBeGreaterThan(0);
  });

  it('…but EvalKit still cannot turn that score into a failing build', async () => {
    const wrong = new ActionChoiceMetric({
      chosenActionId: 'n-subscribe',
      correctActionId: 'n-signin',
      offeredActionIds: ['n-signin', 'n-subscribe'],
    });
    const result = await wrong.executeEvaluation();
    expect(result).toMatchObject({ passed: false, score: 0 });

    // The metric knows it failed. Nothing in EvalKit propagates that: there is
    // no assertion helper, and evaluate() swallows failures. The only thing
    // that can fail CI is the Vitest expect() on the next line — which is the
    // whole gate, and it needed none of the preceding machinery.
    expect(result.passed).toBe(false);
  });
});
