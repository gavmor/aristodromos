# eval-spike: EvalKit (`@evalkit/core`) as a steerability gate

Verdict up front: **MISFIT.** The original hypothesis is confirmed, and for a worse
reason than expected. Every finding below is asserted by a test in
`tests/evalkit-steerability.test.ts`; `pnpm test` reproduces all of it offline.

```
pnpm vitest run tests/evalkit-steerability.test.ts --reporter=verbose
# 13 passed
```


## What was built

Shared protocol, identical across the four eval spikes:

- `tests/eval/steerability-cases.ts` — 3 inline `Scene`s, each with one goal, one
  goal-correct action, and one confounder that is physically more prominent than
  the right answer: sign-in vs. a giant "Subscribe to our newsletter"; reject
  cookies vs. "Accept all"; remove a cart line vs. "Checkout". Typed against
  `utils/scene.ts`, independent of the real projector, so a projector bug cannot
  masquerade as a steering failure.
- `tests/eval/brains.ts` — `deterministicBrain` (reads an answer key; known-good)
  and `randomBrain` (uniform over the reachable triggers, seeded; known-bad).
- `tests/eval/fake-openai.ts` — a loopback HTTP server impersonating the OpenAI
  chat-completions API. This file exists **only** because EvalKit has no offline
  mode; see "Setup weight".

The reference gate (`tests/evalkit-steerability.test.ts:96`) is three `it` blocks
of plain Vitest and does the whole job: `deterministicBrain` scores 3/3 and
passes, `randomBrain` falls for a decoy and fails, and over 300 seeds its mean
pass rate is 0.347 against a chance baseline of 1/3 (each case offers three
reachable triggers). That is the bar EvalKit has to clear.


## How you express the dataset, the grader, and the gate

You don't, really. There is no dataset concept, no case loader, no suite
abstraction — EvalKit is eight metric classes plus an `evaluate()` convenience
wrapper. A "test case" is a plain object whose shape is dictated by the metric:

```ts
new IntentClassificationMetric({ input: string, expectedIntents: string[] })
await metric.executeEvaluation()   // -> { passed, score, reasons }
```

Iteration over cases, parametrisation, and the gate itself are yours to write —
in practice `it.each` plus `expect`, which is exactly the reference gate with
extra ceremony in the middle.

Two things actively get in the way of using it as a gate:

- **`evaluate()` cannot fail a build.** It catches every metric exception,
  `console.error`s it, and returns a report anyway (`:196`). Nothing throws, no
  promise rejects. The only thing that can turn a score into a red build is a
  Vitest `expect()` you write yourself.
- **`ReportService` is a process-wide singleton that is never reset** (`:216`).
  The "report" `evaluate()` returns is not this run's results; it is every
  evaluation the process has ever done, and the returned object *aliases the
  live array* — `run.items` is reference-identical to the service's internal
  list. Per-run scoring is not available without calling the undocumented
  `resetInstance()` between runs. The console reporter also fires
  unconditionally on every `evaluate()` call; there is no quiet mode.


## Fit for a discrete-choice metric

The closest built-in is `IntentClassificationMetric`, and it is not close.

It does separate the right answer from the decoy in our fixture (`:158`) — but
only because our fake judge reports the user message back as the detected
intent, which makes the metric's scoring literally `expectedIntents.includes(input)`.
Against the real endpoint you are paying `gpt-4o-mini` per case to compute
string equality, non-deterministically.

The deeper problem is what the params cannot hold. `{ input, expectedIntents }`
is two blobs of free text. There is nowhere to put **the choice set**. The
grader is never told that `n-subscribe` was on offer and was wrong — asserted at
`:176`: after an evaluation of the login case, neither the string `Subscribe`
nor any offered action id other than the correct one appears anywhere in the
traffic sent to the judge. The confounder, which is the entire point of the
fixture, is inexpressible.

The remaining seven metrics are generation-quality graders — Faithfulness,
Hallucination, Coherence, Bias, Relevancy, Semantic Similarity, Dynamic. All
take text in and return a judge's opinion about its prose. None models "picked
item *k* from a set of *n*".

### Can you add the metric it's missing?

Partly, and not through the front door.

`BaseMetric` **is not exported** (`:230`); `dist/index.esm.js` ships only the
eight concrete metrics plus plumbing, and there is no runtime file to deep-import
(the `dist/metrics/**` tree is `.d.ts` only). So the only reachable base class is
a concrete generation-quality metric.

Subclassing one and overriding `evaluateSteps()` does work at runtime — the
hand-rolled `ActionChoiceMetric` in the test file grades both brains correctly
(`:248`) — but it costs two compiler suppressions, both verified by `tsc`:

- `TS2416`: `evaluationParams` is invariant through the hierarchy, so a subclass
  may not re-type it to a discrete-choice shape.
- `TS2345`: for a metric the library doesn't recognise, `evaluate()`'s
  `LLMTestCase` collapses to the **intersection of all eight built-in param
  types** — the call then demands `input`, `expectedIntents`, `output`,
  `context`, `text1`, `text2`, `actualOutput`, `expectedOutput` *and* `criteria`
  simultaneously (`:272`).

And the forced-through metric still inherits an OpenAI client it never uses, is
still mislabelled "Intent Classification Evaluation" in the report (the name
comes from the `super()` call), and still cannot fail CI on its own (`:287`).
What's left is a `===` behind a cast — the reference gate, slower.


## Confounders and adversarial / red-team datasets

No support. There is no dataset layer to attach adversarial variants to, no
notion of a choice set, no case metadata, no grouping or tagging, no per-case
thresholds (threshold is a constructor arg on the metric, default 0.5). Building
a red-team suite on EvalKit means building the suite in Vitest and calling
EvalKit for the scoring — and the scoring is the part that doesn't fit.


## Integration with our stack

Mechanically fine, which is the one genuinely good thing here: it is a plain ESM
library, no CLI, no parallel runner, no config file required. It imports cleanly
into Vitest and runs under lefthook. The test file needs
`// @vitest-environment node` (loopback HTTP server) and that's it.

Two frictions worth knowing:

- The shipped `.d.ts` disagree with the shipped JavaScript (`:209`).
  `report.service.d.ts` declares `getFinalResult()`; the bundle implements
  `getFinalReport()`. `base.metric.d.ts` declares a `strictMode` field that does
  not exist. Reaching the real API needs a cast.
- `openai@4` wants `zod@^3.23.8`; we are on `zod@4.6.5` (`utils/action-schema.ts`).
  pnpm reports it as an unmet peer. Harmless today, a trap later.


## Setup weight

- `pnpm add -D @evalkit/core` pulls **25 packages**, ~11 MB, almost all of it
  `openai@4` and its Node-18-era shims (`node-fetch@2`, `@types/node@18.19.130`,
  `web-streams-polyfill`, `formdata-node`).
- **Every metric requires `OPENAI_API_KEY` to be constructed**, before any
  evaluation runs (`:145`): `BaseMetric`'s constructor builds an `OpenAI` client
  eagerly, so `new SomeMetric(...)` throws without a key. There is no injectable
  judge and no local-model path — the model is hardcoded `gpt-4o-mini` inside
  each metric body (`text-embedding-ada-002` for Semantic Similarity).
  Configuration is limited to apiKey/baseURL/Azure deployment via an
  `evalkit.config.ts` in cwd, or `OPENAI_API_KEY`/`OPENAI_BASE_URL` in env.
- Consequence for a pre-commit hook: a real key, network egress, per-commit
  token spend and a nondeterministic grader in lefthook — or the fake-OpenAI
  server in `tests/eval/fake-openai.ts`, which is infrastructure we'd own
  forever to test a library whose contribution is then nil.

Project health, for the record: last published 2025-01-12 (v0.0.2, ~21 months
stale), ~1.5k downloads/month, **no `license` field** (npm renders it
"Proprietary"), no `repository` or `homepage` field, and the declared `README.md`
is not actually in the tarball.


## Verdict: MISFIT

Hypothesis confirmed. EvalKit's metrics grade free-text generation quality via an
LLM judge; our gate needs `chosen === correct` over a Scene's choice set, and
`IntentClassificationMetric` is tangential at best — its params have nowhere to
put the offered actions, so the confounder that makes each case worth running is
invisible to the grader.

Worse for a CI gate specifically: the library cannot fail a build (`evaluate()`
swallows errors, there is no assertion API), its reports accumulate
process-globally, and constructing any metric requires an OpenAI key, which puts
a paid nondeterministic judge inside lefthook. Forcing a correct discrete-choice
metric through is possible but lands on two `@ts-expect-error`s and reduces to a
string comparison behind a cast.

Recommendation: do not adopt. For this measurement the honest baseline — `it.each`
over the fixture with `expect(chosen).toBe(correct)` — is strictly better on
every axis, and it is already in this branch at
`tests/evalkit-steerability.test.ts:96`.
