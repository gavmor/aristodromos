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
│ Content script (per tab) │  Scene snapshot      │ Background service worker │
│                          │  ───────────────→    │                           │
│  SceneProjector          │  then JSON-Patch     │  SceneStore (replica)     │
│   · semantic-parser      │  deltas              │  AgentLoop (settle timer) │
│   · node-identity        │                      │  buildActionSchema(Scene) │
│   · perception sources   │  ←───────────────    │  brain → Ollama           │
│  reconciler (actuation)  │  plan                │                           │
└──────────────────────────┘                      └───────────────────────────┘
          │                                                       ▲
          └──────── the page changes ─────────────────────────────┘
```

One `browser.runtime.connect` Port per content-script lifetime. A full `Scene`
goes up on connect and on navigation; everything after that is `fast-json-patch`
deltas. Port disconnect is the lifecycle end — there is no teardown message to
lose.

There are no watermarks, acks or sequence numbers. The loop is **at-least-once
and memoryless**, and it closes **through the world**: the reconciler applies a
plan and then stops, because the projector is already watching and the resulting
DOM change is itself the next observation. `setState` is convergent by
construction, so a replayed plan is a no-op rather than a corruption.

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
├── background.ts       # one AgentLoop per connected tab; follows goal + pause in storage
├── content.ts          # projector, Port, reconciler
├── devtools/           # registers the DevTools panel
└── devtools-panel/     # control + status: pause, goal/brain config, live turn log
utils/
├── scene.ts            # the Scene contract (faithful page simulacrum)
├── scene-projector.ts  # DOM → Scene, dirty-set → targeted JSON-Patch ops
├── semantic-parser.ts  # roles, accessible names, categories, perception
├── node-identity.ts    # stable NodeIds (mirror + semantic re-key), reverse lookup
├── actuation.ts        # per-node actuation recipes (react-setter, pointer sequence)
├── action-schema.ts    # Scene → discriminated-union zod schema
├── brain.ts            # Scene + goal → Plan, via AI SDK generateObject
├── system-one.ts       # typed POST /v1/systemone client (provider-agnostic)
├── system-one-questions.ts # Scene → choice questions; slug ↔ (verb, nodeId)
├── system-one-brain.ts # the System One brain + the confidence gate
├── agent-loop.ts       # settle debounce, tick budget, decide/emit (no browser API)
├── scene-store.ts      # the background's replica, folded from the patch stream
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

## Setting a goal

The agent idles until it is given one — a browser agent with a default goal is an
agent that starts driving the first page you open.

The **Aristodromos** tab in DevTools is the control surface: pause/resume, the
goal, the Ollama model and base URL, the optional System One gate, and a live
turn log for the inspected tab (or all tabs). **Save and run** applies the
config to every connected page at once, with a fresh tick budget, without waiting
for the page to change. While the inspected tab's decision is waiting on the
brain, a spinner and elapsed timer show in the panel header; the background
publishes in-flight decisions to `pending` in `browser.storage.session`. When the
agent is idle on that tab, the header says why (`goal met`, an error, `no goal
configured`), and **Decide now** runs one fresh decision on the page as it is.

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
  },
});
```

The toolbar icon and the panel share one pause switch (`paused` in storage), so it
survives service-worker eviction. Resuming decides on the page as it is now.
Every decision is appended to `turnLog` in `browser.storage.local`, stamped with
its `tabId`.

The content script reopens its Port whenever it closes underneath it: on
service-worker eviction it reconnects (which restarts the worker) and opens with
a full snapshot; around the back/forward cache it lets go on the way in and
reconnects on restore. If the old worker had already gone idle on that exact
Scene, the snapshot is marked `settled`, and the new worker does not ask the
model about it again. Reloading the extension itself is different: the content
scripts already in open tabs are orphaned, so reload those tabs afterwards.

## Evidence

`e2e/evidence/` holds real runs, not fixtures. See
`e2e/evidence/RUN-NOTES.md` for what they show — 8/8 convergence on the login
fixture, the two bugs the runs surfaced, and a deliberately under-powered model
failing honestly.
