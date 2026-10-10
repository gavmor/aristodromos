# spike(bg-harness): KaibanJS — findings

**Verdict: feasible-with-caveats.**

KaibanJS runs the bg-worker decision loop end to end against a local Ollama Qwen,
and the resulting MV3 service-worker chunk both builds *and* boots with zero Node
globals present. The caveats are weight and fit, not capability: `kaibanjs` dragged
**183 extra packages** in and produced a **1.49 MB** service worker for what is
ultimately one agent calling two tools, and its single-agent path is a degenerate
case of a Kanban-board orchestrator we do not want.

---

## What was actually run

| Probe | Command | Result |
|---|---|---|
| Live decision | `pnpm spike:kaibanjs` | PASS — 2 correct actions, 93.6 s, 3 iterations |
| Mock decision | same, `OLLAMA_URL` pointed at a dead port | PASS — identical actions from canned ReAct JSON |
| MV3 SW build | `pnpm build` | PASS — `background.js` 1.49 MB |
| MV3 SW boot | `node spikes/kaibanjs/sw-boot-check.mjs` | PASS — evaluates with no `process`/`require` |
| Repo gates | `pnpm typecheck` / `pnpm test` / `pnpm cpd` | PASS / 84 tests / 0 clones |

### Live-Ollama output (not a mock)

Model auto-selected from `/api/tags`: **`qwen3-coder-ud-q4kxl:latest`**.

```
=== KaibanJS spike — model: LIVE Ollama — qwen3-coder-ud-q4kxl:latest ===
🛠️⏳ USING_TOOL: Agent Projector is  using setState...
🛠️⏳ USING_TOOL: Agent Projector is  using clickTrigger...
🥳 FINAL_ANSWER: Agent Projector arrived to the Final Answer.
| Iterations: 3 | Duration: 93.576 seconds | Input Tokens: 3082 | Output Tokens: 160
| Calls Count: 3 | Calls Error Count: 0 | Parsing Errors: 0

--- emitted actions ---
{"kind":"setState","nodeId":"email","value":"alice@example.com"}
{"kind":"clickTrigger","nodeId":"signin"}
--- workflow status ---
FINISHED | "Set the email to 'alice@example.com' and clicked the sign in button."
```

Both actions reference real Scene node ids, in the right order (converge state,
*then* fire the irreversible trigger). Zero parsing errors on the first attempt.

The mock path (`FakeListChatModel` + canned ReAct JSON) was exercised separately
by pointing `OLLAMA_URL` at a dead port, and emits the same two actions — so the
offline fallback described in the ticket is wired and verified, not just written.

---

## Standalone, or does it need a server?

**Standalone.** `new Team({...}).start()` is an in-process promise. No backend, no
daemon, no board server. The Kanban board is the *optional* hosted UI (Kaiban
Board / `@kaibanjs/*` tooling); the library itself is just a zustand store plus an
agent loop. `getStore()` exposes the state directly for a NodeJS/SW consumer.

## Does it bundle into an MV3 service worker?

**Yes — verified twice, statically and dynamically.**

`wxt build` emits two warnings:

```
Module "node:child_process" has been externalized for browser compatibility,
  imported by .../kaibanjs/dist/bundle.mjs
Module "crypto" has been externalized for browser compatibility,
  imported by .../kaibanjs/dist/bundle.mjs
```

Both are survivable, and the shipped chunk is clean:

- `node:child_process` is a **static top-level import** in `bundle.mjs`
  (`import{spawn as a}from"node:child_process"`), feeding the `ExternalCodingAgent`
  Claude-Code/OpenCode CLI backends. Rolldown tree-shakes that whole branch away —
  the built `background.js` contains **0** occurrences of `child_process`, **0**
  `node:` specifiers and **0** `require(` calls.
- `crypto` is only a guarded `try{require("crypto")}catch{}` fallback for
  `SubtleCrypto`; an MV3 SW has `globalThis.crypto.subtle`, so the fallback is
  never reached. All UUID generation already goes through global Web Crypto
  (`crypto.getRandomValues` / `crypto.randomUUID`).
- All 12 `process.env` reads are guarded by `typeof process < "u"`.

Because "it builds" is not "it boots", `spikes/kaibanjs/sw-boot-check.mjs`
evaluates the built `background.js` inside a `vm` context containing only MV3
service-worker globals — **no `process`, no `require`, no Node builtins** — and it
evaluates cleanly:

```
[Lifecycle] Status → ruminating
[Agent] Using strategy: random-click
SW BOOT OK — background.js evaluated with no Node globals present.
```

Caveat on this evidence: the boot check proves module evaluation and WXT's
`defineBackground` registration, not a full decision executed inside the sandbox.

Also note `bundle.mjs` statically imports **`react`** (for the `useTeamStore`
hook). It resolved here only because `react@18.3.1` arrived transitively; a real
adoption must add `react` as an explicit dependency of an extension that has no UI.

## Node-only deps pulled?

Declared, but none fatal after bundling. `kaibanjs@0.24.2` ships CLI-flavoured
deps — `chalk`, `ansis`, `ora`, `figlet`, `dotenv`, `readline`, plus
`@telemetrydeck/sdk` — but its published `dist/bundle.mjs` is a single 1.66 MB
pre-bundle, so most of that never reaches the extension. The one real Node
coupling in the shipped bundle entry is the `node:child_process` import, and it
tree-shakes out.

Telemetry is worth flagging separately: the bundle reads `KAIBAN_TELEMETRY_OPT_OUT`
and embeds `@telemetrydeck/sdk`. An extension that phones home by default is a
store-review and privacy problem; opt-out would have to be set explicitly.

## LOC / ergonomics for setState + clickTrigger over the Scene

**294 LOC total**, of which only ~79 is the tool layer and ~96 the runner; the
other ~119 is the inline Scene fixture and the SW probe.

Ergonomics are good, because KaibanJS does not invent a tool abstraction:
`type BaseTool = StructuredTool` (`dist/bundle.d.ts:8`) is a straight alias for
LangChain's. So the whole mapping is `tool()` from `@langchain/core/tools` with a
zod schema in and a string out:

```ts
const setState = tool(
  async ({ nodeId, value }) => { /* validate against scene.nodes, push, return string */ },
  { name: 'setState', description: '...', schema: z.object({ nodeId: z.string(), value: z.string() }) },
);
```

Two friction points found while wiring it:

1. **`@langchain/core` must be a direct dependency.** Under pnpm's strict layout it
   is not hoisted, so `import { tool } from '@langchain/core/tools'` fails until you
   add it yourself — and you must pin it into the `0.3.x` band, because `kaibanjs`
   requires `@langchain/core@^0.3.66` while current `@langchain/ollama@1.3.0` peers
   on `^1.0.0`. We are stuck on `@langchain/ollama@0.2.4`. This is a live version
   trap, not a one-time annoyance.
2. **Typing the tool array needs an explicit `StructuredTool[]` annotation**;
   `ReturnType<typeof tool>` resolves to the JSON-schema overload and does not
   accept the zod-schema instances.

Prompting ergonomics are weaker than the tool ergonomics. The agent is told about
the Scene through the *task description* — there is no first-class "observation"
input — so `describeScene()` flattens the node map into prose and interpolates it.
For a memoryless, at-least-once loop that re-decides on every Scene patch, every
tick means constructing a new `Task` and a new `Team`, or mutating the zustand
store underneath a long-lived one. Neither is a natural fit.

## Dep weight

| Metric | Before | After | Delta |
|---|---|---|---|
| Packages in `pnpm-lock.yaml` | 569 | 752 | **+183** |
| `node_modules` | — | 400 MB | — |
| `.output/chrome-mv3/background.js` | — | 1.49 MB | — |

Fourteen `@langchain/*` directories get installed, including **three copies of
`@langchain/openai`** (`0.4.9`, `0.5.18`, `0.6.17`) and two of
`@langchain/community`. Anthropic, Google GenAI, Mistral, DeepSeek, xAI and
Weaviate adapters are all unconditional dependencies of `kaibanjs`, as is
`@browserbasehq/stagehand` (which arrives with unmet peer warnings and drags
Playwright types along). We use exactly one provider — Ollama — and pay for nine.

---

## Verdict

**Feasible-with-caveats.** The harness works: one agent, two Scene-mapped tools, a
live local Qwen, a real structured action plan, and an MV3 service worker that both
builds and boots clean. Nothing here is a blocker.

But the fit is poor in two specific ways. First, cost: +183 packages and a 1.49 MB
service worker to run a single agent through a loop we could express in a few
hundred lines over `@langchain/ollama` alone — and that cost buys nine LLM
providers we will never call, a browser-automation SDK that duplicates our content
script, and default-on telemetry. Second, shape: KaibanJS's unit of work is a
*task assigned to an agent on a board*, with a ReAct protocol parsed out of model
prose by regex. Our unit of work is "one Scene in, one action plan out, no memory".
Every decision tick has to be dressed up as a new Task/Team to fit.

Recommend keeping it as a comparison baseline — it is the proof that the LangChain
runtime *does* survive an MV3 bundle, which is useful knowledge for the other
spikes — but it should lose to any harness that reaches the same result without the
multi-agent board and the nine-provider tax.

---

## Reproduce

```bash
git checkout spike/kaibanjs
pnpm install
pnpm spike:kaibanjs                        # live Ollama, falls back to mock
pnpm build                                 # MV3 SW bundle
node spikes/kaibanjs/sw-boot-check.mjs     # boot the built SW with no Node globals
```

Files: `spikes/kaibanjs/{scene.fixture,tools,run,sw-probe}.ts`,
`spikes/kaibanjs/sw-boot-check.mjs`. `entrypoints/background.ts` carries a
spike-only import of `sw-probe` so the bundle test is real — **this branch is not
for merge.**
