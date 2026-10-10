// eval-spike: Autoevals (Braintrust) as the steerability gate.
//
// Autoevals is a SCORING LIBRARY, not a runner: it hands you `Scorer` functions
// that return a uniform `Score`, and you bring your own loop, dataset, reporter
// and gate. That is why this file is an ordinary Vitest test — there is no
// `autoevals run`, no config file, no YAML. Everything below that is not a call
// into `autoevals` is the part autoevals does NOT give you, and that is the
// finding.
import { ExactMatch, Levenshtein, type Score, type Scorer } from 'autoevals';
import { describe, expect, it } from 'vitest';
import { deterministicBrain, makeRandomBrain, type Brain } from '../evals/brains';
import { offeredActions, steerabilityCases, type SteerabilityCase } from '../evals/steerability';

/** The pass bar for a steerability gate: every case, or the build is red. */
const GATE = 1;

interface Trial {
  caseId: string;
  chosen: string;
  expected: string;
  choseDistractor: boolean;
  score: Score;
}

/**
 * The runner autoevals does not ship. ~10 lines, which is both the complaint
 * and the compliment: there is no framework to fight, and no framework to lean
 * on either.
 */
const runEval = async (
  brain: Brain,
  scorer: Scorer<string, object> = ExactMatch,
  cases: readonly SteerabilityCase[] = steerabilityCases,
): Promise<Trial[]> =>
  Promise.all(
    cases.map(async (c) => {
      const chosen = brain(c, c.goal).actionId;
      return {
        caseId: c.id,
        chosen,
        expected: c.correctActionId,
        choseDistractor: chosen === c.distractorActionId,
        score: await scorer({ output: chosen, expected: c.correctActionId }),
      };
    }),
  );

const mean = (trials: Trial[]): number =>
  trials.reduce((sum, t) => sum + (t.score.score ?? 0), 0) / trials.length;

/** The gate autoevals does not ship either. */
const gate = (trials: Trial[]): { passed: boolean; mean: number; failures: string[] } => {
  const failures = trials
    .filter((t) => (t.score.score ?? 0) < 1)
    .map((t) => `${t.caseId}: chose ${t.chosen}, wanted ${t.expected}${t.choseDistractor ? ' (DISTRACTOR)' : ''}`);
  return { passed: mean(trials) >= GATE, mean: mean(trials), failures };
};

describe('autoevals + vitest: steerability over a discrete Scene choice', () => {
  it('scores a discrete action choice with ExactMatch', async () => {
    const [first] = steerabilityCases;
    const hit = await ExactMatch({ output: first.correctActionId, expected: first.correctActionId });
    const miss = await ExactMatch({ output: first.distractorActionId, expected: first.correctActionId });

    expect(hit.score).toBe(1);
    expect(miss.score).toBe(0);
  });

  it('exposes the uniform Score shape — { name, score } — not { value, rationale }', async () => {
    const score = await ExactMatch({ output: 'btn-signin', expected: 'btn-signin' });

    // The documented selling point is a UNIFORM Score across heuristic and
    // LLM-judge scorers, so one aggregator serves both. The actual field is
    // `score`, and a heuristic scorer carries NO rationale: `metadata` is where
    // the LLM classifiers put theirs, and it is absent here.
    expect(Object.keys(score).sort()).toEqual(['name', 'score']);
    expect(score.name).toBe('ExactMatch');
    expect(score.score).toBe(1);
    expect(score.metadata).toBeUndefined();
  });

  it('PASSES the deterministic brain 3/3', async () => {
    const trials = await runEval(deterministicBrain);
    const result = gate(trials);

    expect(trials.map((t) => t.score.score)).toEqual([1, 1, 1]);
    expect(result).toMatchObject({ passed: true, mean: 1, failures: [] });
  });

  it('FAILS the random brain — the gate discriminates, it does not rubber-stamp', async () => {
    const trials = await runEval(makeRandomBrain(1));
    const result = gate(trials);

    expect(result.passed).toBe(false);
    expect(result.mean).toBeLessThan(1);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('puts the random brain at chance across 200 seeds, and never near the gate', async () => {
    const seeds = Array.from({ length: 200 }, (_, i) => i + 1);
    const means = await Promise.all(seeds.map(async (s) => mean(await runEval(makeRandomBrain(s)))));
    const overall = means.reduce((a, b) => a + b, 0) / means.length;

    // Chance = average over cases of 1/|offered actions| = (1/3 + 1/2 + 1/4)/3
    // = 0.3611. Observed over 200 seeds: 0.3717.
    const chance =
      steerabilityCases.reduce((sum, c) => sum + 1 / offeredActions(c.scene).length, 0) /
      steerabilityCases.length;

    expect(overall).toBeGreaterThan(chance - 0.08);
    expect(overall).toBeLessThan(chance + 0.08);

    // 8 of 200 seeds (4%) clear a 3-case gate by luck alone. The harness
    // discriminates, but THREE CASES IS A THIN GATE — whichever framework wins,
    // the dataset has to grow before this is load-bearing in CI.
    expect(means.filter((m) => m >= GATE).length / means.length).toBeLessThanOrEqual(0.05);
  });

  it('records WHICH wrong answer was taken — autoevals scores, it does not diagnose', async () => {
    // A 0 from ExactMatch is just a 0. "Chose the prominent Subscribe button"
    // vs "chose Continue shopping" is the whole point of a steerability suite,
    // and that attribution lives in our Trial, not in the Score.
    const alwaysDistractor: Brain = (c) => ({ actionId: c.distractorActionId, confidence: 1 });
    const trials = await runEval(alwaysDistractor);

    expect(trials.every((t) => t.score.score === 0)).toBe(true);
    expect(trials.every((t) => t.choseDistractor)).toBe(true);
    expect(gate(trials).failures.every((f) => f.includes('DISTRACTOR'))).toBe(true);
  });

  it('shows why the other heuristic scorers are a trap for ids: Levenshtein pays partial credit', async () => {
    // `btn-remove-warranty` vs `btn-remove-telescope` are different actions with
    // different consequences, but they are similar STRINGS. Any fuzzy scorer
    // will award a wrong-but-adjacent id most of the credit. For a discrete
    // choice the only defensible scorer in the library is ExactMatch.
    const fuzzy = await Levenshtein({ output: 'btn-remove-telescope', expected: 'btn-remove-warranty' });
    const strict = await ExactMatch({ output: 'btn-remove-telescope', expected: 'btn-remove-warranty' });

    expect(fuzzy.score).toBeGreaterThan(0.4);
    expect(strict.score).toBe(0);
  });

  it('accepts a hand-written Scorer with a rationale, aggregated by the same code', async () => {
    // THIS is the part of autoevals worth keeping. `Scorer`/`Score` is the seam:
    // when the real brain lands and grading becomes "did this multi-step plan
    // pursue the goal", the judge (LLM or not) swaps in here and `runEval` /
    // `gate` are untouched. Factuality / ClosedQA / LLMClassifierFromTemplate
    // are drop-in at this same signature — they just need an API key, which is
    // why they are not in this CI gate.
    const steerability: Scorer<string, object> = ({ output, expected }) => ({
      name: 'GoalDirectedChoice',
      score: output === expected ? 1 : 0,
      metadata: {
        rationale:
          output === expected
            ? `chose ${output}, which is what the goal asked for`
            : `chose ${output}; the goal called for ${expected}`,
      },
    });

    const good = gate(await runEval(deterministicBrain, steerability));
    const bad = await runEval((c) => ({ actionId: c.distractorActionId, confidence: 1 }), steerability);

    expect(good.passed).toBe(true);
    expect(gate(bad).passed).toBe(false);
    expect(bad[0].score.metadata?.rationale).toContain('the goal called for');
    // Same aggregator, different scorer family — no change to runEval or gate.
    expect(bad[0].score.name).toBe('GoalDirectedChoice');
  });
});
