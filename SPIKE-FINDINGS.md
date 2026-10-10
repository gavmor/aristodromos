# spike(bg-harness): Mastra (`@mastra/core`)

Throwaway spike. Question: can `@mastra/core` be the aristodromos background-worker brain,
bundled into the WXT MV3 service worker?

**Verdict: feasible-with-caveats, and the caveats are close to disqualifying.**
The programming model is the best thing in this spike — Scene-derived tool schemas express the
memoryless contract in ~70 lines, and a live local Qwen emitted exactly the right plan. But
`@mastra/core` is a server framework: 132 packages and 5.58 MB into the service worker,
21 Node builtins stubbed out by the bundler, and three unguarded `Function()` sites that MV3's
CSP rejects. It *bundles*. Whether it *runs* in a real MV3 worker is unproven.

---

## What was actually run

| | |
|---|---|
| `@mastra/core` | `1.75.0` (pinned — see "Supply chain") |
| Model | **live Ollama**, `qwen3-coder-ud-q4kxl:latest` (30.5B, `tools`, no `thinking`) |
| Runtime for the decision | **Bun 1.4.0**, `bun spike/run.ts` — *not* a service worker |
| Bundle probe | `pnpm build` (WXT 0.20.26 / rolldown), chrome-mv3 |

Repro:

```
pnpm install
bun spike/run.ts     # one decision, prints the emitted actions
pnpm build           # MV3 bundle probe (background.ts imports spike/bg-bundle-probe.ts)
```

A passing run:

```
model: live ollama qwen3-coder-ud-q4kxl:latest

emitted actions (2):
  setState(email, "alice@example.com")
  clickTrigger(signin)

all node ids valid: true
```

That is the success criterion: a structured plan whose every argument is a real Scene node id,
produced by the model *calling tools* — not by us parsing prose.

### It only passes about half the time

Six consecutive runs: **3 passed, 3 emitted zero actions.** On the failures the model wrote the
call out as JSON *text* in the response body instead of using the tool-call channel:

```
reasoning text: "{\"name\": \"setState\", \"arguments\": {\"nodeId\": \"email\", …}}\n…"
emitted actions (0):
```

This is **not** a Mastra defect. I captured the exact HTTP body Mastra sends (a clean
`/v1/chat/completions` with correct JSON-Schema `tools` and `tool_choice: "required"`, no
bloat) and replayed that identical body with plain `curl` six times: 5/6 returned `tool_calls`,
one returned none. The flakiness lives in qwen3-coder / Ollama's tool-call emission, not in the
harness. Any of the seven harnesses will inherit it; it is a model-selection problem, not a
framework-comparison one.

Two settings matter and are worth carrying to the other spikes:

- `toolChoice: 'required'` — on `'auto'` the text-instead-of-tool-call failure is more frequent.
- `maxSteps: 1` — with `maxSteps: 4` the model re-emits the whole plan after each tool result
  (observed 4, 6 and 8 actions for a 2-action page). `setState` is convergent so a repeat is
  harmless, but a repeated `clickTrigger` is not something at-least-once makes safe. One
  observation → one plan is both safer and the actual contract.

---

## Standalone, or does it need a server?

**Standalone.** `new Agent({…}).generate(…)` works with no `new Mastra()` container, no storage,
no `mastra dev`, no HTTP server. The server packages (`@mastra/deployer`, playground) are
separate installs we never touched.

Caveat: *the class* is standalone, the *package* is not. Importing only `@mastra/core/agent`
still drags the product surface in through shared chunks — workspace/skills filesystem loaders,
workflow event processor, a2a, storage domains, voice, telemetry, the full generated provider
registry.

---

## MV3 service worker: does it bundle?

Yes. `pnpm build` succeeds. The numbers:

| `background.js` | bytes |
|---|---|
| main, no Mastra | **4,789** (4.79 kB) |
| this branch, Mastra Agent reachable | **5,580,314** (5.58 MB) |

**~1,165×**, for a module whose whole job is "take a Scene, emit two tool calls". The content
script is unchanged at 8.38 kB.

(An earlier measurement read 5.82 MB because the spike imported Mastra's
`test-utils/llm-mock`, which pulls msw and `net`/`http`/`https`/`zlib`. The offline mock is now
hand-rolled — 30 lines — so the figure above is Mastra's Agent path alone.)

### Node-only modules pulled in

26 externalized specifiers, **21 distinct Node builtins**. "Externalized" means rolldown
replaced them with stubs instead of failing the build, so any code path that reaches them dies
at *runtime*, in the worker, not at build time:

```
async_hooks  buffer  child_process  crypto  dns  events  fs  fs/promises
http  https  module  net  os  path  path/posix  readline  stream
stream/web  url  util  zlib
```

Who imports them:

- `@mastra/core` **agent chunk itself** — `crypto`, `fs`, `path`, `stream/web`, `async_hooks`
- `@mastra/core` **tools chunk** — `dns`, `net`, `http`, `https`, `fs/promises`, `os`, `path`, `url`
- `workspace-*` / `filesystem-versioned-*` — `child_process`, `fs`, `module`, `stream`
- `provider-registry-*`, `storage-*`, `workflow-event-processor-*`, `voice-*`, `logger-*`
- `posthog-node` (product telemetry) — `node:fs`, `node:readline`, `node:zlib`, `node:async_hooks`
- `js-yaml` — `buffer`

The ticket's stated risk is **confirmed**: `ws` is a direct dependency, `dns`/`net`/`http` come
in through Mastra's own tools chunk, and WebSocket code is present in the emitted bundle.

### The sharp edge: `Function()` under MV3 CSP

Four `Function(...)` constructor call sites survive into `background.js`. MV3 extension CSP is
`script-src 'self'` with no `unsafe-eval`, so each throws `EvalError` when executed:

1. **zod** — `try { Function('') } catch {}` JIT feature probe. *Safe*: guarded, falls back to
   the jitless path. (Good sign: zod already expects CSP environments.)
2. **ajv** — `Function(self, scope, code)` compiling JSON-Schema validators at runtime. Unguarded.
3. **Mastra `resolveSerializedZodOutput`** — `Function('z', 'return (' + src + ')')`.
4. **Mastra `resolveZodSchema`** — same shape, plus a `SafeRegExp` argument.

(3) and (4) rehydrate schemas that arrived as *strings* — MCP tools, stored agent definitions —
so an agent built locally from `createTool` plausibly never reaches them. "Plausibly" is the
problem: **I did not load the built extension into Chrome**, so this spike does not prove the
worker boots.

Separately, rolldown emitted an `[EVAL]` warning for `gray-matter`'s direct `eval(str)`; that
one is tree-shaken out of the final bundle, so it is build-log noise, not shipped risk.

---

## Ergonomics: `setState` + `clickTrigger` over the Scene

Genuinely good. `spike/scene-tools.ts` is **69 lines** including the Scene serializer; the whole
spike is **328 lines** across five files.

The tool surface is derived *from the Scene*, per observation:

```ts
inputSchema: z.object({
  nodeId: z.enum(idsByCategory(scene, 'state')),   // only ids that exist, right now
  value:  z.string(),
})
```

That fits the memoryless contract exactly: rebuild the tools from the current observation and
the model *structurally cannot* name a node that is not on the page. Disabled nodes drop out of
the enum for free. Mastra validates tool input against the schema before `execute` runs, so the
background worker never sees a malformed action — which is the whole reason to use a harness
instead of `JSON.parse` on model prose (cf. the hand-rolled `LLMStrategy` in `utils/agent.ts`).

---

## Model wiring

**`ollama-ai-provider` turned out to be unnecessary.** It is installed as the ticket specified,
but the spike does not import it:

- `ollama-ai-provider@1.2.0` is an AI SDK **v4** provider (`LanguageModelV1`, peer `zod@^3` —
  it installs with an unmet-peer warning against `zod@4`). Mastra 1.75 carries provider specs
  v5/v6/v7. `MastraModelConfig` still admits a V1 model through a legacy path, but that is the
  deprecated lane.
- Mastra's built-in OpenAI-compatible model router already does the job with zero extra deps:

```ts
model: { id: 'ollama/qwen3-coder-ud-q4kxl:latest',
         url: 'http://localhost:11434/v1',
         apiKey: 'ollama' }
```

An unknown provider id routes to the openai-compatible adapter against the supplied `url`, and
Ollama's `/v1/chat/completions` handles `tools` correctly. If Mastra survives the MV3 question,
drop `ollama-ai-provider`.

The offline fallback — a hand-rolled `LanguageModelV2` returning a canned two-call plan — is
wired in `spike/model.ts` and **was verified** by pointing `OLLAMA_URL` at a dead port: it
emits `setState(email, …)` + `clickTrigger(signin)` through the real Mastra tool loop. The
headline run above is live, not mocked.

Model choice: `pickOllamaModel()` prefers a tool-capable qwen *without* the `thinking`
capability. `qwen3.5:latest` also produces the right plan but burns ~30 s of chain-of-thought
first — ~65 s per decision versus ~4 s.

---

## Dependency weight

| | packages added | disk |
|---|---|---|
| `@mastra/core@1.75.0` | **132** | **79 MB** (`node_modules/.pnpm/@mastra+core@…`) |
| `ollama-ai-provider@1.2.0` (installed, unused) | 5 | — |
| `zod@4.6.5` (required peer) | 1 | — |

Notable passengers: `posthog-node` (telemetry), `hono` + `hono-openapi` (HTTP server), `execa`
(child processes), `ws`, `croner` (scheduler), `dotenv`, `re2js`, `xxhash-wasm`, `gray-matter`,
`@a2a-js/sdk` ×2, and three parallel copies of `@ai-sdk/provider` (v2.0.3 / v3.0.14 / v4.0.17).

### Supply chain

`@mastra/core` **1.42.1 is flagged malicious by OSSF Malicious Packages** — the local scanner
refused an unpinned `pnpm add @mastra/core` for exactly that reason. This branch pins `1.75.0`.
Adopting Mastra would mean an exact pin plus a lockfile audit, not a caret range.

---

## Verdict

**Feasible-with-caveats**, where the caveats are structural rather than incidental.

For expressing the Scene→action contract, Mastra is the nicest thing I could have asked for:
per-observation `z.enum` tool schemas make invalid node ids unrepresentable, validation happens
before our code runs, and the whole harness is ~70 lines. If the brain lived in Node, this
would be a straight yes.

As an MV3 service-worker dependency it is the wrong shape. `@mastra/core` ships a filesystem
layer, a scheduler, a child-process runner, an HTTP stack and a telemetry client in the same
barrel as the Agent; the bundler papers over 21 Node builtins and leaves three unguarded
`Function()` sites that MV3's CSP rejects. 5.58 MB for a decision loop is the symptom, not the
disease.

One experiment flips this to a yes or a no: load `.output/chrome-mv3` unpacked in Chrome and
see whether the worker registers and `__mastraSpike()` completes. Until someone does that,
"it bundles" is strictly weaker than "it runs" — and the ~50% tool-call rate from the local
model, which is **not** Mastra's fault, needs solving regardless of which harness wins.
