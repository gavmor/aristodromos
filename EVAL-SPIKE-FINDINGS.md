# Eval-framework spike: Autoevals (Braintrust)

Branch `eval/autoevals`. One of four parallel spikes grading the same mock deciders
against the same steerability fixture, so the only variable is the harness.

What landed:

    evals/steerability.ts        3 inline Scenes + goal + correct action + confounding distractor
    evals/brains.ts              deterministicBrain (always right), makeRandomBrain(seed) (chance)
    tests/eval-autoevals.test.ts the eval, as an ordinary Vitest file

Run it: `pnpm test`. 8 tests, ~2s, no network, no API key.

    autoevals@0.4.0   +27 packages   openai@6.49.0 pulled in as a hard dependency (20 MB)


## Observed results

    deterministicBrain   [1, 1, 1]   mean 1.0000   gate PASSES
    randomBrain (seed 1) [0, 0, 0]   mean 0.0000   gate FAILS
    randomBrain, 200 seeds           mean 0.3717   chance = 0.3611
    seeds that clear 3/3 by luck     8 / 200 (4%)

Chance is (1/3 + 1/2 + 1/4)/3 — the three cases offer 3, 2 and 4 reachable actions
respectively. The harness discriminates: it is not green-lighting everything.

Note the 4%. With only three cases a coin-flipping brain ships a green build one run
in twenty-five. That is a property of the DATASET, not of autoevals, and it will bite
whichever framework wins. The gate needs more cases before it is load-bearing.


## How you express the three things

**Dataset.** A TypeScript array. There is no dataset primitive in autoevals — no
loader, no schema, no case ids, no tagging, no splits. `steerabilityCases` is a
`readonly SteerabilityCase[]` and the "loader" is `Array.prototype.map`. That is zero
ceremony and zero leverage; for our fixture (hand-authored Scene objects with
structural invariants) plain TS is genuinely the right medium, but nothing about
autoevals helped.

**Grader.** This is the actual product:

```ts
const score = await ExactMatch({ output: chosen, expected: case.correctActionId });
// -> { name: 'ExactMatch', score: 1 }
```

`Scorer<Output, Extra> = (args: { output, expected?, ...extra }) => Score | Promise<Score>`
and `Score = { name, score: number | null, metadata?, error? }`.

Two corrections to the ticket's description. The field is `score`, not `value`. And
`rationale` is not a field on `Score` at all — the LLM classifiers put theirs in
`metadata.rationale`; heuristic scorers carry no `metadata` key whatsoever (asserted
in the test). The uniformity claim is still true, it is just one field shallower than
advertised.

**Gate.** Does not exist. `runEval` and `gate` in the test file are ours — about 25
lines for the loop, the mean, the threshold and the failure list. autoevals returns a
number per call and stops there.


## Fit for a discrete-choice steerability metric

Right answer, trivially. `ExactMatch` on a node id is exactly the metric, it is
synchronous, deterministic, and free. We use one export out of ~40.

Two things worth flagging:

- **The rest of the heuristic family is a trap here.** `Levenshtein` scores
  `btn-remove-telescope` against `btn-remove-warranty` at **0.55**, and
  `btn-subscribe` against `btn-signin` at **0.46**. Those are different actions with
  different consequences — removing the wrong line item, converting instead of
  logging in — and a fuzzy scorer pays them half credit. Opaque NodeIds (which is
  what the real projector emits) would mask this rather than fix it. ExactMatch is
  the only defensible scorer in the library for this metric, and the library will
  happily hand you a wrong one.
- **A `0` is just a `0`.** "Chose the prominent Subscribe button" and "chose Continue
  shopping" are the same score. Distractor attribution — the entire point of a
  steerability suite — lives in our `Trial` record, not in anything autoevals
  returns. The test asserts this explicitly.


## Confounding / distractor cases, and red-teaming later

No support, and no obstruction. Distractors are a property of the fixture; autoevals
never sees the Scene, only two strings. There is no adversarial generation, no
mutation, no perturbation, no dataset synthesis — contrast promptfoo, which ships red
teaming as a first-class feature.

The flip side: because the grader is a plain function of `(output, expected)`,
nothing stops us writing distractor-rate or trap-family aggregates ourselves, and
nothing in the library has an opinion about our Scene shape. For a project with a
bespoke observation model that counts for something.


## Integration with our stack

Best of the four on this axis, by construction. autoevals is a library, not a runner:
it runs **inside Vitest**, so `pnpm test` is the gate, lefthook's existing pre-commit
`vitest run` already enforces it, and CI needs no new job, no new config file, no
second reporter, no YAML. The eval is a `.test.ts` next to `reconciler.test.ts`.

Nothing else here does that without adding a parallel runner.


## Setup weight

`pnpm add -D autoevals`, one import, done — no config file, no init, no server, no
account, no key for the heuristic path.

The dependency bill is less tidy than "lightest" suggests. 27 transitive packages,
including **openai@6.49.0 (20 MB)** as a hard `dependency` rather than an optional
peer, plus an ML stack — `ml-matrix` (1.3 MB) and `ml-spectra-processing` (5.3 MB)
arrive via `linear-sum-assignment`, which exists to serve `ListContains`. We are
pulling ~27 MB and an LLM SDK into a browser-extension repo to do `a === b`. It is a
devDependency so it never reaches the bundle, but it is not nothing, and it is
strictly more than writing `===`. autoevals also ships a `preinstall` script (a pnpm
check), which pnpm blocked by default.


## Where the LLM judge WOULD earn its keep

Today the brain emits a `Plan`, not a single action: `{ satisfied, remaining, actions[] }`
over a multi-turn loop. ExactMatch cannot grade "did this trajectory pursue the goal",
"was `satisfied` an honest reading of the page", or "did it re-set a control that was
already correct". Those are judgments, and the judgment path is where `Scorer`/`Score`
stops being a wrapper and starts being a seam:

```ts
const steerability: Scorer<string, object> = ({ output, expected }) => ({
  name: 'GoalDirectedChoice',
  score: output === expected ? 1 : 0,
  metadata: { rationale: `chose ${output}; the goal called for ${expected}` },
});
```

The test swaps this in for `ExactMatch` and `runEval`/`gate` do not change a line.
`Factuality`, `ClosedQA`, `LLMClassifierFromTemplate` sit at that same signature — add
an API key and they drop straight in, and `metadata.rationale` gives the failure a
readable cause instead of a zero. That is the one durable thing on offer: a stable
grader interface that lets the heuristic gate of today become the judge-backed gate of
later without rewriting the harness around it.

Caveat on that future: LLM judges mean network, cost and nondeterminism, which do not
belong in a pre-commit hook. That path is a nightly/periodic suite, not lefthook —
which is an argument for a harness that can express two tiers, and autoevals has no
opinion about tiers either.


## Verdict — WORKABLE, and the hypothesis is CONFIRMED with one correction

The ticket's hypothesis: *"LIGHTEST but under-powered as a harness — exact-match is
trivial, no dataset/gate/red-team; value is the Score abstraction for later LLM-judge
grading."*

Confirmed on every clause but one. It is under-powered as a harness because it is not
a harness: no dataset primitive, no gate, no reporter, no red-teaming, no CLI. Roughly
25 lines of this spike are ours and three are autoevals'. And the residual value is
exactly the `Scorer`/`Score` seam for later judge-based grading.

The correction is "lightest". Lightest in *concepts* and *integration* — unbeatable
there, it runs in the Vitest we already have and gates in the lefthook we already
have. Not lightest in *dependencies*: 27 packages and the OpenAI SDK to compare two
strings.

So: pick autoevals if the decision is that the gate should live inside `pnpm test`
and we would rather own 25 lines of loop than adopt a second runner — the `Scorer`
seam then makes the eventual LLM-judge upgrade a one-line swap. Pick something else
if we want the dataset/reporting/red-team machinery handed to us, because autoevals
has none of it and never will.
