# aristodromos

A browser extension whose agent **pursues a goal** on the web — it reads the
page, strategizes, acts, and adapts across as many steps as the task takes,
driving the page the way a person chasing an objective would. Under the hood it
perceives the page as a semantic model, decides with a local LLM, actuates, and
re-perceives.

## Goal

Give the agent an objective — *"book the cheapest nonstop", "sign in and download
the latest invoice", "find the seller and message them"* — and let it **pursue
that goal to completion**: reading the page, choosing the next move, acting,
seeing what changed, and **adapting its strategy** over however many steps the
task takes.

A single memoryless, structured decision — look at the current page, emit one
valid action — is the **atomic step, not the destination**. The direction of the
project is to compose those steps into genuine goal pursuit: planning a route to
the objective, carrying forward what has and hasn't worked, recognising dead ends
and backtracking, and **optimising toward the goal** rather than merely reacting
to the page in front of it. The loop below is step one — the foundation the rest
builds on.

## The loop

```
┌──────────────────────────┐                      ┌───────────────────────────┐
│ Content script (per frame)│  Scene snapshot     │ Background service worker │
│                          │  ───────────────→    │                           │
│  SceneProjector          │  then JSON-Patch     │  TabScene (frames → one)  │
│   · semantic-parser      │  deltas              │  AgentLoop (settle timer) │
│   · node-identity        │                      │  buildActionSchema(Scene) │
│   · perception sources   │  ←───────────────    │  brain → Ollama           │
│  reconciler (actuation)  │  plan                │                           │
└──────────────────────────┘                      └───────────────────────────┘
          │                                                       ▲
          └──────── the page changes ─────────────────────────────┘
```

One `browser.runtime.connect` Port per content-script lifetime, and one content
script per **frame**: the top document and every iframe, cross-origin included.
A full `Scene` goes up on connect and on navigation; everything after that is
`fast-json-patch` deltas. Port disconnect is the lifecycle end — there is no
teardown message to lose.

The background keeps one loop per **tab**. `TabScene` folds each frame's stream
into its own replica and composes them into the one Scene the brain sees, with
node ids namespaced by frame (`f0.n12` is the top document's, `f14.n3` is an
iframe's). A plan's actions route back to their frames by that prefix, in each
frame's own ids. Frames under 100×100 (tracking pixels, hidden iframes) are left
out, and each composed frame hangs under the `<iframe>` that embeds it, so it
reads where the page shows it.

## What the model reads

The Scene is a flat, id-keyed map because that is what patches cheaply and what
the schema's enums are built from. It is not what the model reads. Every node
also records its `parent` (nearest projected ancestor) and `order` (position
among its siblings — sibling-local, so an insertion renumbers only the siblings
after it), and `describeScene` renders that as an indented outline in reading
order:

```
(heading 2) "Status"
(table)
  (row) Atmosphere: | 100%
  (row) Hull: | 40%
(paragraph) "Something scrapes against the hull."
[n12] (button) "Seal the airlock"
[n13] (button) "Vent the bay"
```

A value sits beside its label, a choice under the passage it answers. Only lines
the schema can name carry an `[id]`; disabled controls are still shown, flagged,
without one. Unnamed wrappers are dropped and a row of plain cells reads as one
line. A link shows where it goes (`(link) "Next" </chapter-2>`), cut at 100
characters; a `javascript:` link shows none.

Visibility is the browser's own (`Element.checkVisibility()`), not the element's
own CSS: a control inside a `display: none`, `opacity: 0` or `aria-hidden="true"`
container is not seen, so it is neither shown nor nameable. (`checkVisibility()`
ignores ARIA, so the `aria-hidden` ancestor is checked alongside it; under jsdom,
which lacks `checkVisibility()`, `isInaccessible` from `dom-accessibility-api`
stands in, plus the opacity walk.) A control's *own* opacity is the one
exception — custom checkboxes are real inputs at opacity 0. Because CSS can show
or hide things with no record on the element itself (a flag on `<html>`, a
stylesheet, an animation ending), any attribute change anywhere, a stylesheet
coming or going, or a transition or animation ending re-checks `visible` for
every projected node in that frame's flush.

Text that sits bare in a block (a story engine's passage, prose never wrapped in
`<p>`) reads as `(text)`; inline wrappers like `<em>` stay part of the sentence,
and text a paragraph, control or label already carries is not repeated. Page text
is shown whole under one overall budget, spent on what is on screen first, and no
single block may take more than 1 500 characters of it.

There are no watermarks, acks or sequence numbers. The loop is **at-least-once
and memoryless**, and it closes **through the world**: the reconciler applies a
plan and then stops, because the projector is already watching and the resulting
DOM change is itself the next observation. `setState` is convergent by
construction, so a replayed plan is a no-op rather than a corruption. A plan that
is applied but changes nothing (a dead link) would leave the page silent, so after
a few seconds without change the loop decides again, within its tick budget.

Memorylessness is deliberate *for this first step* — it is what makes the loop
robust and replay-safe — but it is the floor, not the ceiling. Strategizing
toward a goal (a plan the agent maintains and revises, and memory of what it has
tried across steps) is the next layer, and it will build **on top of** this loop
rather than replace it.

## The action schema is the point

The schema is rebuilt **from the live Scene on every decision** and handed to
Ollama's `format`, which compiles it to GBNF and constrains the sampler. It is a
discriminated union, not a generic `(nodeId, value)` pair:

```jsonc
{ "kind": "setState",     "nodeId": <enum of state ids>,   "value": <typed per node> }
{ "kind": "clickTrigger", "nodeId": <enum of trigger ids> }   // no value, ever
```

- `value` is typed per node: a select's own options as an enum, a checkbox as a
  boolean, a range with its own min/max.
- The two node-id enums are **disjoint**, so neither verb can reach the other's
  nodes.
- `disabled` and modal-inert nodes are dropped from the enums. They are still
  *described* in the observation — "Submit exists but is greyed out" is exactly
  the signal that tells the model to go fill the fields first — they are just not
  nameable as actions.
- `javascript:` links are dropped too. A click from the content script runs that
  URL under the extension's CSP, which blocks it, so the click would change
  nothing. Links driven by `onclick` (the usual `href="#"`) are kept.

A generic schema is satisfied by `clickTrigger` on a text field carrying a value,
and a weak local model will emit precisely that. Here it has no representation,
so it never has to be rejected downstream.

The model also decodes `satisfied` **before** anything else. In a memoryless
loop the page is the only record of what has already been done, and forcing the
model to read current values first is what stops it re-filling fields it filled
a turn ago.

Around the actions, the plan itself is a union, and there is no empty plan:

```jsonc
{ "satisfied": "…", "remaining": "…", "actions": [ /* at least one */ ] }
{ "satisfied": "…", "done": true }
```

An empty action list used to mean "finished", so a model that simply chose
nothing looked exactly like one that had finished, and the loop idled with the
goal unmet. Now the model must act or claim the goal met, and the grammar has no
third answer.

## The same guarantee, one layer down: System One

The decision has a second, cheaper implementation behind the same seam:
`POST /v1/systemone` against any **Jev-compatible** provider. It is a classifier
call, not a chat call — you send a `state` and a map of `questions`, and every
answer is read from **label-token probabilities**. One forward pass, nothing
parsed out of generated text, and a calibrated confidence per answer.

Where `buildActionSchema` makes an illegal `(verb, nodeId)` pair
**unrepresentable** in a grammar, `buildActionQuestions` makes it
**unnameable** in a choice:

```jsonc
{ "next_action": { "type": "choice", "criteria": {
    "fill_email_address":          "Set Email address (text control, currently \"\")…",
    "fill_password":               "Set Password (text control, currently \"\")…",
    "toggle_remember_this_device": "Set Remember this device (boolean control, currently false)…"
    // no click_sign_in — the page has it disabled, so it is not an option at all
}}}
```

Every legal pair gets exactly one option; an illegal pair gets none, so no amount
of probability mass can land on it. Disabled and modal-inert nodes are withheld
from the label set for the same reason they are withheld from the enum — still
*described* in the state blob, just not choosable.

Labels are slugs of the **accessible name**, not node ids. A model answering from
label tokens needs the semantics in the label: `fill_email_address` carries
signal, `n5` does not. The slug → `(verb, nodeId)` map comes back out of the
builder, so the decode is exact.

Two things System One structurally cannot do, and what each one implies:

- **It cannot generate text.** So a free-text value is never asked of it. The
  *target* is still chosen by System One, and the AI SDK brain is called only to
  supply the string. Enumerable values — a checkbox's true/false, a select's own
  options — *are* label choices, so they ride in the same request and never cross
  the seam. A `setState` decision takes the **minimum** of target and value
  confidence: a sure target with an unsure value is not a sure decision.
- **It cannot decide that nothing is left to do.** Every choice question has a
  winner, so an action question alone can never terminate the loop. A `noul`
  (yes/no → P(yes)) carries that judgement instead, and it is the brain's only
  stop condition.

The **gate** only routes. It never edits a confident decision and never asks the
big model to ratify one. Low confidence, a needed value, or a System One failure
all go to the AI SDK brain, and the reason rides in the turn log's `via` field
next to `confidence`. An optional accelerator must not be able to stop the agent,
so an unreachable server falls through rather than throwing.

`confidence` is read as an **opaque server output**, never recomputed. Against a
real jev.cpp response (`p_max` 0.9754878 over K=3, reported 0.96323171) the
normalized-entropy form `1 - H(p)/ln K` gives 0.880, while the scaled max
probability `(p_max - 1/K)/(1 - 1/K)` reproduces the reported value exactly — and
different providers may calibrate differently anyway.

All of this is **additive**: with no `systemOne` in the config the loop runs the
AI SDK brain alone, exactly as before.

## Project structure

```
entrypoints/
├── background.ts       # one AgentLoop per tab, over all its frames; follows goal + pause in storage
├── content.ts          # projector, Port, reconciler
├── devtools/           # registers the DevTools panel
└── devtools-panel/     # control + status: pause, goal/brain config, turn log, live Scene
utils/
├── scene.ts            # the Scene contract (faithful page simulacrum)
├── scene-projector.ts  # DOM → Scene, dirty-set → targeted JSON-Patch ops
├── semantic-parser.ts  # roles, accessible names, categories, perception
├── node-identity.ts    # stable NodeIds (mirror + semantic re-key), reverse lookup
├── actuation.ts        # per-node actuation recipes (react-setter, pointer sequence)
├── action-schema.ts    # Scene → discriminated-union zod schema
├── brain.ts            # Scene + goal → Plan via AI SDK generateObject; describeScene's outline
├── system-one.ts       # typed POST /v1/systemone client (provider-agnostic)
├── system-one-questions.ts # Scene → choice questions; slug ↔ (verb, nodeId)
├── system-one-brain.ts # the System One brain + the confidence gate
├── tracing.ts          # one OTLP provider per endpoint+project: AI SDK telemetry + a tracer
├── openinference-decision/ # DECISION spans over a fetch seam (Apache-2.0 fork; LICENSE, NOTICE)
├── agent-loop.ts       # settle debounce, tick budget, decide/emit (no browser API)
├── scene-store.ts      # one frame's replica, folded from its patch stream
├── tab-scene.ts        # a tab's frames composed into one Scene; frame-namespaced node ids
├── reconciler.ts       # Plan → page effects, with noop/stale/rejected honesty
├── wire.ts             # the Port contract
├── content-port.ts     # content end of the Port: reconnects after eviction/bfcache, re-announces the Scene
└── agent-config.ts     # goal + model (+ optional System One), in browser.storage.local
e2e/
├── fixtures/login.html # a form whose submit is disabled until the fields are valid
├── run.ts              # headless Chromium, real extension, real Ollama
├── systemone-probe.test.ts # real projector + real Jev server, one decision per page state
└── repeat.sh           # run it N times and tally convergence
```

## Commands

| Command | Action |
|---|---|
| `pnpm dev` | WXT dev server (HMR) |
| `pnpm build` | Production MV3 build |
| `pnpm test` | Vitest unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm cpd` | Copy-paste detection |
| `pnpm e2e` | Build, then drive a real page headlessly end to end |
| `pnpm probe` | One System One decision per page state, against a real Jev server |

## Prerequisites

- **pnpm**, at the version pinned by `packageManager` in `package.json`
- **Ollama** on `localhost:11434` (override with `OLLAMA_BASE_URL`, e.g.
  `http://192.168.0.20:11434/api`) with `qwen3-coder-ud-q4kxl:latest`
  (Qwen3-Coder-30B-A3B, ~17 GB — MoE, 3B active, fast enough to sit in a
  per-observation loop)
- Chromium at `/usr/bin/chromium` for `pnpm e2e` (override with `CHROMIUM_PATH`)
- *Optional*, for the System One path: any server speaking `POST /v1/systemone`.
  Point `pnpm probe` at it with `JEV_BASE_URL` / `JEV_MODEL`.
- *Optional*, for tracing: any OTLP/HTTP (protobuf) collector; Arize Phoenix is
  the intended one (`docker run -p 6006:6006 arizephoenix/phoenix`, or
  `pip install arize-phoenix && phoenix serve`). Set
  `PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006/v1/traces` and `pnpm e2e`
  traces its decisions into the `aristodromos-e2e` project.

## Setting a goal

The agent idles until it is given one — a browser agent with a default goal is an
agent that starts driving the first page you open.

It also runs **only in tabs you switch it on for**: click the toolbar icon in a
tab to switch it on or off there (the badge shows ▶, or ⏸ while paused, and is
blank where it is off), or use the panel's switch. Everywhere else it still
perceives, so the panel can show the Scene, but it never acts — not even in a
tab its own click opened. The switched-on tabs live in `enabledTabs` in
`browser.storage.session`, since a tab id means nothing after a restart, and a
closed tab drops out.

The **Aristodromos** tab in DevTools is the control surface: the switch for this
tab, a global pause/resume, the goal, the Ollama model and base URL, the
optional System One gate, optional tracing, and a live turn log for the inspected
tab (or all tabs). **Save and run** applies the config to every tab the agent is on for, with
a fresh tick budget, without waiting for the page to change. While the inspected
tab's decision is waiting on the
brain, a spinner and elapsed timer show in the panel header; the background
publishes in-flight decisions to `pending` in `browser.storage.session`. When the
agent is idle on that tab, the header says why (`goal met`, an error, `no goal
configured`), and **Decide now** runs one fresh decision on the page as it is.

The **Scene** section is a live, collapsible view of the inspected tab's Scene:
the background forwards that tab's snapshot and patch stream over a dedicated
Port, and the panel composes it into its own `TabScene`, so it shows exactly what
the brain decides on. Expanded nodes stay expanded as the page changes. The
viewer is `@andypf/json-viewer`, with a one-line pnpm patch
(`patches/@andypf__json-viewer@2.8.0.patch`): unpatched, any data update after
a click re-collapses every row, which defeats its `preserveExpanded` option.

The same state lives in `browser.storage.local`, so it can also be set directly:

```js
chrome.storage.local.set({
  agentConfig: {
    goal: 'Sign in as alice@example.com with the password hunter2.',
    model: 'qwen3-coder-ud-q4kxl:latest',
    baseURL: 'http://localhost:11434/api',

    // Optional. Omit it and the Ollama brain decides every turn, as before.
    // Present, and the classifier decides first with Ollama as the fallback
    // below `threshold` (or whenever a free-text value is needed).
    systemOne: {
      baseURL: 'http://localhost:18080',
      model: 'autojev',
      threshold: 0.6,
    },

    // Optional. Omit it and nothing is traced. Present, and every brain call
    // is sent as an OpenInference trace to this OTLP endpoint.
    tracing: {
      endpoint: 'http://localhost:6006/v1/traces',
      project: 'aristodromos',
    },
  },
});
```

The global pause (`paused` in `browser.storage.local`) survives service-worker
eviction. Resuming, or switching a tab on, decides on the page as it is now.
Every decision is appended to `turnLog` in `browser.storage.local`, stamped with
its `tabId`.

The content script reopens its Port whenever it closes underneath it: on
service-worker eviction it reconnects (which restarts the worker) and opens with
a full snapshot; around the back/forward cache it lets go on the way in and
reconnects on restore. If the old worker had already gone idle on that exact
Scene, the snapshot is marked `settled`, and the new worker does not ask the
model about it again. Reloading the extension itself is different: the content
scripts already in open tabs are orphaned, so reload those tabs afterwards.

### Tracing decisions

With `tracing` set, each `generateObject` call is exported as an OpenTelemetry
trace, enriched by `@arizeai/openinference-vercel` so Phoenix reads it as an
`AGENT` span over an `LLM` span. The trace holds the system prompt, the goal and
outline the model saw, the plan it returned, the model, and token counts: the
place to look when a choice is wrong.

The integration is passed to each call (`telemetry.integrations`), never
registered globally, so it follows the stored config like the brain does:
switched on, off, or re-pointed without restarting the worker. A service worker
has no context manager, which is fine, since the AI SDK passes each child span's
parent explicitly, and it can be evicted at any idle moment, so each span is
exported as it ends rather than batched. The OTLP exporter's browser build sends
with `fetch`; the extension's host permissions cover the collector, so Phoenix
needs no CORS setup.

With `systemOne` set as well, each `POST /v1/systemone` is exported through the
same provider as an OpenInference
[`DECISION`](https://github.com/Arize-ai/openinference/blob/main/spec/decision_spans.md)
span: the request and response bodies as `input.value` / `output.value`,
`decision.system` = `typesafe` (the spec's value for the Jev shape, whoever
serves it), the requested and answering models, and `usage` as
`decision.token_count.input` / `.output`. No `decision.provider` is set, since
nothing in the protocol says who runs a Jev server. A non-2xx is an error span
with its status and body; a transport failure is an error span with the
exception.

When the gate falls back, the System One call and the Ollama call are two traces,
not one. The AI SDK roots its spans in the active context, and a worker has no
context manager to make the gate that context; adjacent start times are the link.

`utils/openinference-decision/` does the DECISION spans. It is a fork of
OpenInference's TypeSafe instrumentation, Apache-2.0, with its own `LICENSE` and
`NOTICE`. Upstream patches `@typesafe-ai/sdk` through a require hook, which a
bundled worker cannot do; here a decision client's `fetch` is wrapped instead
(`traceDecisions`), with the tracer and parent context passed in. What differs
between decision APIs is one constant per protocol: `JEV_SYSTEM_ONE`, and
`OPENAI_DECISIONS` for OpenAI's `POST /v1/decisions` (system and provider both
`openai`), which reads the same `model` and `usage` fields. No client calls the
latter yet.

## Evidence

`e2e/evidence/` holds real runs, not fixtures. See
`e2e/evidence/RUN-NOTES.md` for what they show — 8/8 convergence on the login
fixture, the two bugs the runs surfaced, and a deliberately under-powered model
failing honestly.
