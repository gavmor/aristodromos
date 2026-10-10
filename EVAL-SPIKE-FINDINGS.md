# Eval-framework spike: Arize Phoenix / Pydantic Logfire (OpenTelemetry)

Branch `eval/phoenix-logfire`. One of four parallel spikes grading the same mock
deciders against the same steerability fixture, so the only variable is the harness.
`evals/steerability.ts` and `evals/brains.ts` are byte-identical to the `eval/autoevals`
branch.

What landed:

    evals/steerability.ts           SHARED: 3 inline Scenes + goal + correct action + distractor
    evals/brains.ts                 SHARED: deterministicBrain, makeRandomBrain(seed)
    evals/otel-harness.ts           TracerProvider; in-memory sink + opt-in OTLP->Phoenix
    evals/instrumented-loop.ts      the mock loop, emitting a 3-span turn per tick
    evals/span-grader.ts            the evaluator: score the DECISION span; emit annotations
    tests/eval-phoenix-logfire.ts   the eval, as an ordinary Vitest file

Run it: `pnpm test`. 12 tests, 46 ms of test time, no collector, no container, no token.

    @opentelemetry/{api,sdk-trace-base,resources,semantic-conventions,exporter-trace-otlp-proto}
    @arizeai/openinference-semantic-conventions@2.14.0
    @pydantic/logfire-api@0.9.0
    +15 packages, ~18 MB on disk, all devDependencies

A note on the naming before anything else, because the ticket's title conflates two
things. **Phoenix and Logfire are not two harnesses.** They are two BACKENDS behind one
instrumentation. This spike emits one span shape and proves the same evaluator grades it
whether the spans were produced by the raw OTel API or by `logfire.span()`. Nothing in
`span-grader.ts` knows which vendor is downstream. That is the single most important
finding here, and it is the reason this seat is cheaper to occupy than it looks.


## Observed results

    deterministicBrain      [1, 1, 1]   mean 1.0000   gate PASSES   9 spans
    randomBrain (seed 1)    [0, 0, 0]   mean 0.0000   gate FAILS    9 spans
    randomBrain, 200 seeds              mean 0.3717   chance = 0.3611
    seeds that clear 3/3 by luck        8 / 200 (4%)

Identical to the `eval/autoevals` numbers to four decimals, which is the point: same
fixture, same brains, same discrimination. The harness is not green-lighting everything.

What this harness adds that a string scorer could not produce:

    labels over 200 seeds x 3 cases:  correct 223 | distractor 232 | wrong 145
    distractor rate 0.3867            wrong rate 0.2417

On seed 1 the random brain walks into the **confounding distractor on all three cases** —
Subscribe over Sign in, Claim-my-discount over No-thanks, Checkout over Remove-warranty —
and the failure output says so by name:

    sign-in-not-subscribe [distractor]: chose the distractor btn-subscribe. Subscribe is
    the page's primary CTA and the most common button on a paywalled news site.
    (wanted btn-signin)

"Steered by the page" and "wrong some other way" are different failures. This harness
reports them separately because the label is a first-class part of the annotation payload,
not something bolted onto a numeric score.


## Verified against a real Phoenix, not just asserted

`docker run -p 6006:6006 arizephoenix/phoenix:latest`, then the same eval with
`PHOENIX_COLLECTOR_ENDPOINT` set. Measured, this session:

    image pull            21 s      1.39 GB
    container ready       26 s      cold start, no volume
    idle memory           435 MB
    traces ingested       6         project "aristodromos-steerability"
    annotations POSTed    3         HTTP 200, ids returned

Read back over Phoenix's GraphQL API:

    {"name":"scene.project","spanKind":"tool","spanAnnotations":[]}
    {"name":"decide","spanKind":"decision","spanAnnotations":[
        {"name":"steerability","label":"correct","score":1.0,"annotatorKind":"CODE"}]}
    {"name":"agent.turn","spanKind":"chain","spanAnnotations":[]}

Three things that actually matter in that output:

1. **`spanKind: "decision"` is first-class.** OpenInference 2.14 added a `DECISION` span
   kind and a `decision.*` attribute family for exactly our shape — *"a decision model
   takes state plus typed questions and returns a typed, structured answer."* That is a
   literal description of `utils/brain.ts`: a Scene plus a Scene-derived zod schema in,
   one structurally-valid `Plan` out. We are not bending an LLM-chat vocabulary to fit a
   structured-output decider; the vocabulary already has our case in it.
2. **The grade attaches to the span by id**, scoped to the one span that made the choice.
   `scene.project` and `agent.turn` stay unannotated. The gate's verdict and the trace a
   human inspects are the same object.
3. **The resource attribute routed the project.** `openinference.project.name` on the
   Resource is all the configuration Phoenix needed.

The container was torn down afterwards; nothing in `pnpm test` depends on it.


## How you express the three things

**Dataset.** A TypeScript array, same as autoevals — and then a problem autoevals does not
have. The dataset is not an input to the run; it is a thing you JOIN to the telemetry
afterwards. OpenInference has `session.id`, `user.id`, `metadata` and nothing for "which
dataset example produced this span", so the join key is bespoke:

```ts
export const CASE_ID_ATTRIBUTE = 'aristodromos.case.id';
```

Every emitter and every grader has to agree on that string by convention. Phoenix's own
answer to this is Datasets + Experiments (upload examples, run a task against them, and it
keys the spans for you) — which is a real feature, and it is also a server, a dataset
upload and a second runner. For a pre-commit gate it is not worth it.

**Grader.** Ours, as with every other candidate. The difference is *selection*: you do not
receive an output, you go find it.

```ts
export const decisionSpans = (spans: readonly ReadableSpan[]): ReadableSpan[] =>
  spans.filter((s) => s.attributes[OPENINFERENCE_SPAN_KIND] === OpenInferenceSpanKind.DECISION);
```

Select by **kind**, never by name or position. Two tests pin why:

- `scene.project` also carries an `output.value`. A grader taking "the last span with an
  output" scores the projector's node count against an action id — forever, silently. The
  test asserts the naive selector picks the wrong span.
- Logfire names spans after the message TEMPLATE, so the decision span is literally called
  `decide {aristodromos.case.id}`. Selecting by `span.name === 'decide'` finds nothing the
  moment you switch emitters. Selecting by kind survives.

**Gate.** Ours too, ~15 lines, and it needs one guard the other harnesses do not:

```ts
passed: missing.length === 0 && evaluations.length === cases.length && mean >= gate
```

A case with no decision span fails the gate OUTRIGHT rather than shrinking the denominator.
The test instruments 2 of 3 cases and shows `mean === 1` with `passed === false`. **Silent
instrumentation loss is how a trace-based gate goes green while measuring nothing**, and it
is a failure mode that simply does not exist when the runner owns the dataset loop. If we
pick this seat, that guard is not optional.


## Two gotchas that cost real debugging time, both measured

Neither is in anyone's docs, both bit this spike, and both would bite us again.

**1. No ContextManager means no trace.** With `BasicTracerProvider` and no context manager
registered, `tracer.startActiveSpan` does not parent anything: the first run of this spike
produced three *unrelated single-span traces* per turn instead of one three-span turn, and
a grader walking a trace would have seen nothing to walk. There is no good context manager
where this code actually runs either — an MV3 service worker has no `AsyncLocalStorage`,
and a content script has only the sync-stack manager. The portable fix is to thread the
parent explicitly and skip implicit context entirely:

```ts
const within = trace.setSpan(context.active(), turn);
tracer.startSpan(DECISION_SPAN_NAME, undefined, within);
```

One extra argument, and it works identically in Node, jsdom and MV3. Logfire has the same
dependency and the same escape hatch (`{ parentSpan }`).

**2. `logfire-api` binds its tracer at import.** It resolves `trace.getTracer('logfire')`
at module load — before any provider exists — and that stale handle never heals. Every
`logfire.span()` call then succeeds, throws nothing, logs nothing, and records **zero
spans**. A Logfire-instrumented eval can go green having measured literally nothing. The
fix is a re-bind after the provider is registered:

```ts
trace.setGlobalTracerProvider(provider);
configureLogfireApi({ otelScope: 'logfire' });
```

Same hazard class as the missing-span case, from the other end. Note what both have in
common: **telemetry fails open.** A dataset runner that cannot read its dataset throws; an
instrumentation layer that cannot emit just... doesn't.


## Fit for a discrete-choice steerability metric

Workable and faintly absurd, in that order. The metric is `chosen === expected` and we
built a span pipeline to carry two strings to it. Everything in `otel-harness.ts` and the
span-selection logic in `span-grader.ts` is overhead against a `===` that autoevals does in
one line.

But two parts of the apparatus are not overhead:

- **`DECISION` span kind.** The eval's description of the system is the same description
  production would use. No translation layer, no test-only shim.
- **Three labels, not two.** `{ label, score, explanation }` is the native annotation
  shape, so distractor attribution is free rather than something we staple onto a number.

Worth saying plainly: **none of the span machinery is load-bearing for the metric we have
today.** It is load-bearing for the metric we say we want.


## Confounding / distractor cases, and red-teaming later

No generation, no mutation, no adversarial dataset synthesis — nothing like promptfoo's red
team. Distractors are a property of the fixture, as everywhere else.

What the trace seat does give, uniquely: distractor attribution is **queryable after the
fact**. The spans hold the full choice menu in `input.value`, the chosen action in
`output.value`, and the verdict in the annotation. Asking "across every run this month,
which distractor families do we lose to" is a Phoenix query, not a code change. No other
candidate in this bake-off accumulates history at all — the others are green/red and then
the information is gone.


## Integration with our stack

Better than expected, and this is where my prior was wrong.

**It runs inside Vitest.** No parallel runner, no YAML, no CLI, no second reporter.
`tests/eval-phoenix-logfire.test.ts` sits next to `reconciler.test.ts`, lefthook's existing
pre-commit `vitest run` gates it, CI needs no new job. On the integration axis it ties
autoevals, which I did not expect from the "heavier: needs a collector/platform" framing.

**The platform is strictly optional.** Scoring is `InMemorySpanExporter` + a filter. The
OTLP exporter is behind a dynamic import keyed on `PHOENIX_COLLECTOR_ENDPOINT`, so a CI run
never loads the protobuf runtime it does not use. Hermetic by default; `docker run` only
when a human wants to look at something.

**The tie-in to traced-harness is real but not free.** This repo emits `TurnRecord`
(`utils/wire.ts`): tick, url, `opsSinceLastTurn`, afforded node ids, satisfied/remaining,
actions, ms, error. That is a span in all but name — `TurnRecord` -> `agent.turn` CHAIN
span with the `Plan` fields as attributes is a mechanical translation, and this spike is
most of the proof. What it is NOT is automatic: somebody writes that adapter, and somebody
owns the ContextManager decision in MV3. Call it a day of work, not an afternoon.

Setup weight: 15 packages, ~18 MB, no config file, no account, no key. Lighter in deps
than autoevals (27 packages, pulls `openai` at 20 MB). The weight is the *platform*, and
the platform is opt-in: 1.39 GB image, 26 s cold start, 435 MB idle — paid only by whoever
runs `docker run`, never by `pnpm test`.


## Where this seat actually earns its keep

The current brain is memoryless and emits a `Plan` per tick. The README now frames the
destination as multi-step goal pursuit — planning a route, carrying forward what has and
hasn't worked, recognising dead ends, backtracking. **A per-choice metric cannot score
that**, and this spike contains the proof rather than the assertion.

`gradeTrace` keys its span index by case id alone, so a second decision span for the same
case silently overwrites the first. There is a test for it: run two ticks on one case,
wrong then right, and the grader reports ONE evaluation and calls it correct. A trajectory
metric would call that "recovered"; a per-choice metric cannot see it at all.

The telemetry holds both ticks. Only the grader throws one away. Fixing it means keying on
`(case, tick)` and asking a different question — trajectory length, wasted actuations,
whether `satisfied` was an honest reading of the page, whether a dead end was recognised or
re-entered — and every one of those is a question about a *tree of spans*, not about a
string. That is what trace-shaped evidence is for, and it is the one thing a flat
`(output, expected)` runner can never be upgraded into.


## Verdict — OVERKILL NOW, RIGHT SEAT LATER. Hypothesis CONFIRMED, with one correction.

The ticket's hypothesis: *"OVERKILL now but the right long-term seat — span/trace scoring is
how multi-step goal-pursuit (strategic adherence) gets evaluated; ties to traced-harness
OTel."*

Confirmed on both clauses. Overkill now: the metric is `===`, and ~290 lines of harness
plus 15 packages carry two strings to it where autoevals needs one import. Right seat
later: `DECISION` span kind describes our brain exactly, span annotations attach verdicts
to the decisions that earned them, and the single-tick collapse test shows precisely where
a per-choice metric runs out of road.

The correction is **"heavier: needs a collector/platform."** It does not. Scoring is an
in-memory exporter and a filter; the eval runs in `pnpm test` in 46 ms with no container
and no token, and it gates in the lefthook we already have. The platform buys trace
inspection and accumulated history, and it is opt-in behind one environment variable. The
weight the ticket feared is real but it is *elective*, and it is not on the CI path.

So: pick this if we believe the next milestone is multi-step goal pursuit and we would
rather instrument once — the same spans then serve CI, local debugging and the eventual
trajectory metric. Pick autoevals if the honest scope is "gate the single-tick choice and
move on", because today that is three lines and this is three hundred.

The two are not mutually exclusive and that may be the real answer: autoevals' `Scorer`
seam for the per-choice gate now, this instrumentation when the loop grows a memory. What
would be a mistake is adopting the platform — the container, the datasets, the experiments
— before there is a trajectory to look at.
