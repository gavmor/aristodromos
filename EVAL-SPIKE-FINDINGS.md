# Eval spike: Promptfoo

Branch `eval/promptfoo`. One of four parallel spikes on the same shared protocol:
grade a **discrete choice over a Scene** (steerability) against **mock** deciders,
with confounding distractors, as a **CI gate**. No model, no provider, no network.

Everything below was run on this branch; every number is from a real run, quoted verbatim.

---

## What was built

```
evals/steerability.ts            3 cases: inline typed Scene + goal + correct trigger + distractor
evals/brains.ts                  deterministicBrain (ceiling), randomBrain (seeded floor)
evals/promptfoo/provider.ts      promptfoo ApiProvider wrapping a brain          (33 lines of code)
evals/promptfoo/graders.ts       two custom TS assertions                        (52 lines of code)
evals/promptfoo/tests.ts         the dataset, as promptfoo test cases            (13 lines of code)
evals/promptfoo/promptfooconfig.yaml   the config: providers, graders, gate
evals/promptfoo/redteam.yaml     the red-team hook — SKETCH, see §5, it does not run
```

The three traps: credentials already typed next to a loud `Subscribe — get 20% off`;
a search query already typed behind `Accept all cookies`; a correct cart next to
`Add 3-year protection — recommended`. Each case offers four reachable triggers,
so an unsteered policy scores 25% by construction.

`offeredActionIds()` reuses the real `isReachable` from `utils/action-schema.ts`, so
"the options a brain was offered" means the same thing here as in production — the
disabled `btn-clear` is reported in the Scene and excluded from the options, exactly
as the live action schema does it. Nothing imports the real projector.

---

## 1. How the dataset, the grader, and the gate are expressed

**Dataset — TypeScript, not YAML.** Promptfoo's native idiom is YAML rows, but a
`Scene` literal in YAML is unverifiable: rename a field in `utils/scene.ts` and the
fixture rots silently. Promptfoo's `tests: file://tests.ts` hook takes a module, so
the fixtures stay typechecked by `pnpm typecheck` and promptfoo gets scalar vars for
its results table. This cost nothing and is the right call — but note that the thing
promptfoo is best known for (a readable YAML dataset) is the part we gave up.

**Grader — 100% custom.** Promptfoo ships ~60 built-in assertion types. *None* fit:
`equals` compares the whole JSON blob, `contains` passes on a response that merely
mentions the right id, `llm-rubric` burns a model call to re-derive a fact we already
know exactly. We used the `javascript` escape hatch for every assertion:

```yaml
defaultTest:
  assert:
    - type: javascript
      value: file://graders.ts:gradeSteerability
      metric: steerability
    - type: javascript
      value: file://graders.ts:gradeDistractorResistance
      metric: distractor-resistance
```

The `file://path.ts:exportName` form works out of the box — `tsx` is one of promptfoo's
direct dependencies, so TS graders need no extra config. Returning a full `GradingResult`
(not just a boolean) is what makes the output readable; see the quoted reasons in §3.

Two metrics, not one, because *wrong* and *mis-steered* are different bugs:
`gradeSteerability` asks "did it pick the goal-correct trigger", `gradeDistractorResistance`
asks "did the trap specifically catch it". A policy wandering to `btn-forgot` and a policy
reliably clicking `Add protection` both score 0 on the first and differ on the second.

**Gate — the process exit code.** `promptfoo eval` exits `0` on all-pass and `100` on any
failure. `--filter-providers` lets one config serve both runs:

```jsonc
"eval:gate":    "promptfoo eval -c … --filter-providers deterministic --no-cache",  // must be 3/3
"eval:bakeoff": "promptfoo eval -c … --no-cache"                                    // both brains
```

---

## 2. Fit for a DISCRETE-CHOICE metric (vs generation-quality metrics)

Mixed, and this is the crux.

Promptfoo's model of the world is `prompt → string → assert on the string`. Ours is
`Scene → actionId`. The mismatch shows up in three places:

- **The prompt is vestigial.** Our provider reads the typed fixture by `caseId` and
  ignores the rendered prompt entirely. The prompt exists to label a column.
- **Every built-in assertion is text-shaped** and therefore unusable (above).
- **The "provider" is not a model.** The `ApiProvider` interface is a thin
  `id() + callApi() → { output }`, which is pleasant to implement but means the adapter
  is doing translation work promptfoo does not know about.

So we are not using promptfoo as a *prompt evaluator*. We are using it as a test runner,
a results table, a metric aggregator, and an exit code. The honest question is whether
those are worth 450 packages (§4).

What it does genuinely well for a discrete choice: **named-metric aggregation across
providers**, which is exactly the model bake-off shape this repo keeps doing
(`spike/ai-sdk-ollama`, the `r2-*` worktrees). One table, N policies, per-metric scores.
Also `--repeat N`, which matters a lot the moment the decider is a real stochastic model
and 3/3 stops being a meaningful number.

---

## 3. Discrimination — the actual evidence

The harness is only worth anything if it separates a perfect policy from a random one.
`pnpm eval:bakeoff` (seed `20261010`), verbatim:

```
│ login-vs-subsc… │ btn-signin      │ btn-subscribe     │ [PASS] │ [FAIL] │
│ search-vs-cook… │ btn-search      │ btn-accept-coo…   │ [PASS] │ [FAIL] │
│ checkout-vs-up… │ btn-place-order │ btn-add-warran…   │ [PASS] │ [FAIL] │

Results:
  ✓ 3 passed (50.00%)
  ✗ 3 failed (50.00%)
Duration: 0s (concurrency: 4)
ELIFECYCLE  Command failed with exit code 100.
```

Aggregated per provider:

```
deterministic-brain :: pass=3/3 named={"steerability":3,"distractor-resistance":3}
random-brain        :: pass=0/3 named={"steerability":0,"distractor-resistance":2}
```

And the gate run, `pnpm eval:gate`:

```
  ✓ 3 passed (100%)
  0 failed (0%)
GATE_EXIT=0
```

The per-case reasons are where the custom `GradingResult` pays off — the floor brain
took the bait on exactly one case and the report says so in those words:

```
random-brain | login-vs-subscribe      | missed: chose btn-forgot, wanted btn-signin
                                       | distractor-resistance=PASS  not confounded by btn-subscribe
random-brain | search-vs-cookie-banner | missed: chose btn-reject-cookies, wanted btn-search
                                       | distractor-resistance=PASS  not confounded by btn-accept-cookies
random-brain | checkout-vs-upsell      | took the bait: chose the distractor btn-add-warranty,
                                       |   wanted btn-place-order
                                       | distractor-resistance=FAIL  confounded by btn-add-warranty
```

Ceiling passes, floor fails, and the two metrics disagree in the informative way.
The harness discriminates.

---

## 4. Integration with our stack

**It is a second runner.** Promptfoo does not host vitest tests and vitest cannot host
promptfoo evals. That is the structural cost and there is no way around it.

It is, however, a *cheap* second runner here, because the mock brains make it offline:

```
pnpm eval:gate   real 1.7s   (3 cases, 6 assertions, exit 0)
pnpm test        real 2.4s   (61 tests)
```

So it fits in `pre-commit` today, and this branch wires it in to prove the claim rather
than assert it:

```yaml
    eval:
      run: pnpm eval:gate
```

That stops being true the day it grades a real model: a commit hook cannot afford
network or tokens, and the gate moves to CI. The repo has no `.github/workflows` yet, so
nothing was invented for it — when it exists, `promptfoo eval -o results.junit.xml` emits
JUnit directly, which is the cheapest possible CI wiring.

**Three side effects worth knowing before adopting:**

1. **Stateful outside the repo.** Every run writes eval history to a SQLite DB at
   `~/.promptfoo/promptfoo.db` (455 KB after five runs). Harmless locally, invisible on
   an ephemeral CI runner, but it is global mutable state a test runner does not have.
2. **Telemetry on by default** via `posthog-node`, with an anonymous install id written
   to `~/.promptfoo/promptfoo.yaml`. `PROMPTFOO_DISABLE_TELEMETRY=1` turns it off; every
   run in this document set it.
3. Nothing is written into the repo. `git status` stayed clean apart from our own files.

---

## 5. Red-team / adversarial — the hypothesis fails here

This is the part of the hypothesis that does not survive contact.

The pitch is strong: hand-written distractors only catch confounders we already imagined,
and `promptfoo redteam` generates the rest, with `excessive-agency` ("acting beyond what
the goal asked for" — the upsell click) and `hijacking` ("purpose deviation" — the cookie
banner) being almost suspiciously on-target plugin names for a web agent.

**But the red-team module is account-gated.** Running it with *only* the locally authored
`intent` plugin and no generation provider — i.e. the most offline configuration the module
allows — gets this:

```
  Email Verification Required
  Red team scans require email verification to continue.
? Work email:
RT_EXIT=1
```

It is not a local library you can call; it is the on-ramp to promptfoo's hosted service.
Generation additionally defaults to `--provider openai:chat:gpt-5.5-*` plus promptfoo's
remote generation service, so it is neither free nor offline even past the email wall.

Consequence: red-teaming can never be our commit gate. The only workable shape is a periodic
job that generates cases and **writes them to disk**, which the offline `promptfoo eval` gate
then replays for free. That shape is available from *any* generator — so the red-team module
is not a reason to pick promptfoo over the alternatives. It is a reason to budget for an
account.

There is also unfinished work between `redteam.yaml` and a real adversarial suite, documented
in that file: our provider ignores the prompt, so no generated attack string can move it. It
would need a Scene-**mutating** mode that splices the generated text into the Scene as a new
prominent `ActionNode` before the policy sees it. The graders in `graders.ts` would then work
unchanged — that part is genuinely clean.

---

## 6. Setup weight

| | |
|---|---|
| Install | `pnpm add -D promptfoo@0.124.1` → **+450 packages**, −5 |
| Disk | **350 MB** in `node_modules/.pnpm` for promptfoo's tree alone |
| Direct prod deps | **74** |
| Peer warnings | 2 unmet (`gcp-metadata`, `chokidar`) |
| Node | requires `>=22.22.0` |
| Config | 1 YAML + 3 TS files, 98 lines of adapter code |
| Keys needed | **none** for `eval`; an account for `redteam` |
| Shipped bundle | **unaffected** — `pnpm build` succeeds, `.output/` totals 449.69 kB and contains no `promptfoo` string |

Dev-only, and verified so rather than assumed: `pnpm build` (wxt, chrome-mv3) succeeds on a
clean `--frozen-lockfile` checkout of this branch, `grep -r promptfoo .output/` finds nothing,
and `git diff main...eval/promptfoo -- entrypoints utils wxt.config.ts` is empty — the
extension's build inputs are byte-identical to main, so none of this weight reaches users.
It is all on developer and CI machines.

What those 74 deps contain is the uncomfortable part: `express`, `socket.io`,
`drizzle-orm`, `@libsql/client`, six OpenTelemetry packages, `posthog-node`,
`openai`, `@anthropic-ai/sdk`, `python-shell`, `simple-git`, `protobufjs`. A web
server, an ORM, an analytics client and two model SDKs land in a browser-extension
repo's dev tree so that we can run three exact-match comparisons. `tsx` being in
there is the one dep we actually benefit from.

---

## 7. Verdict for our need: **workable, not strongest**

**The hypothesis is half confirmed and half refuted.** Confirmed: the
dataset + custom-assertion + exit-code gate really does land on steerability cleanly —
~105 lines of adapter buys a typed dataset, exact-match grading, two named metrics
aggregated side by side across policies, and a 1.7s offline gate that provably separates a
perfect policy from a random one. Refuted: the red-team module, which was the main thing
making this the *strongest* candidate, is gated behind email verification and a hosted
service even in its most local configuration, so it cannot be our gate and is not a
differentiator against the other three spikes.

**The cost is also not mainly the parallel runner.** The second runner turned out cheap
(1.7s, offline, fits in lefthook today). The real costs are 450 packages / 350 MB of
server-and-ORM dependencies for what is fundamentally exact-match comparison, a SQLite
history DB in `$HOME`, telemetry on by default, and the fact that we use promptfoo's
`javascript` escape hatch for 100% of our grading while its ~60 built-in text assertions
sit unused.

**Where it would genuinely earn its keep** is the day the decider is a real model and the
question becomes "which of these five model/prompt configurations steers best, over N
repeats": side-by-side provider columns, `--repeat`, named-metric aggregation and caching
are exactly that job, and that is a job this repo keeps doing by hand. If the comparison is
instead "did this commit break steerability", a Vitest-native harness gets the same signal
with none of the weight. Pick promptfoo if the bake-off is the recurring need; do not pick
it for the gate alone.
