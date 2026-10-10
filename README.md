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

A generic schema is satisfied by `clickTrigger` on a text field carrying a value,
and a weak local model will emit precisely that. Here it has no representation,
so it never has to be rejected downstream.

The model also decodes `satisfied` and `remaining` **before** `actions`. In a
memoryless loop the page is the only record of what has already been done, and
forcing the model to read current values first is what stops it re-filling fields
it filled a turn ago.

## Project structure

```
entrypoints/
├── background.ts       # one AgentLoop per connected tab; goal + turn log in storage
└── content.ts          # projector, Port, reconciler
utils/
├── scene.ts            # the Scene contract (faithful page simulacrum)
├── scene-projector.ts  # DOM → Scene, dirty-set → targeted JSON-Patch ops
├── semantic-parser.ts  # roles, accessible names, categories, perception
├── node-identity.ts    # stable NodeIds (mirror + semantic re-key), reverse lookup
├── actuation.ts        # per-node actuation recipes (react-setter, pointer sequence)
├── action-schema.ts    # Scene → discriminated-union zod schema
├── brain.ts            # Scene + goal → Plan, via AI SDK generateObject
├── agent-loop.ts       # settle debounce, tick budget, decide/emit (no browser API)
├── scene-store.ts      # the background's replica, folded from the patch stream
├── reconciler.ts       # Plan → page effects, with noop/stale/rejected honesty
├── wire.ts             # the Port contract
└── agent-config.ts     # goal + model, in browser.storage.local
e2e/
├── fixtures/login.html # a form whose submit is disabled until the fields are valid
├── run.ts              # headless Chromium, real extension, real Ollama
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

## Prerequisites

- **pnpm** 10.30.1 (locked via `packageManager`)
- **Ollama** on `localhost:11434` with `qwen3-coder-ud-q4kxl:latest`
  (Qwen3-Coder-30B-A3B, ~17 GB — MoE, 3B active, fast enough to sit in a
  per-observation loop)
- Chromium at `/usr/bin/chromium` for `pnpm e2e` (override with `CHROMIUM_PATH`)

## Setting a goal

The agent idles until it is given one — a browser agent with a default goal is an
agent that starts driving the first page you open.

```js
chrome.storage.local.set({
  agentConfig: {
    goal: 'Sign in as alice@example.com with the password hunter2.',
    model: 'qwen3-coder-ud-q4kxl:latest',
    baseURL: 'http://localhost:11434/api',
  },
});
```

The toolbar icon toggles pause/resume. Every decision is appended to
`turnLog` in `browser.storage.local`.

## Evidence

`e2e/evidence/` holds real runs, not fixtures. See
`e2e/evidence/RUN-NOTES.md` for what they show — 8/8 convergence on the login
fixture, the two bugs the runs surfaced, and a deliberately under-powered model
failing honestly.
