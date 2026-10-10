# SPIKE: dexto (truffle-ai) as the aristodromos bg-worker brain

Branch: `spike/dexto` · throwaway · happy-path only · **do not merge**

Harness: `spike/dexto/harness.ts` (142 LOC) + `spike/dexto/scene-fixture.ts` (78 LOC)
Run with: `bun spike/dexto/harness.ts`

---

## Verdict: INFEASIBLE (for the stated MV3 constraint)

`@dexto/core` is a genuinely good in-process agent SDK and it drove our Scene
correctly on a live local Qwen on the first honest attempt. It is also, concretely and
by its own documentation, a **Node server library**: its `browser` export condition
deliberately ships types and constants with *no agent at all*, and forcing the Node
entry into a WXT MV3 build pulls winston, google-auth-library, cross-spawn, node-fetch
and OpenTelemetry behind it — 160 "externalized for browser compatibility" warnings
across 36 distinct Node builtins before the build dies outright. It would be a fine
brain if the brain lived in a host process the extension talks to; it cannot be the
brain *inside* the service worker.

---

## 1. Is there an embeddable SDK, or only a CLI/app? — RISK REFUTED

The npm package named `dexto` is CLI-only: its `package.json` has `bin.dexto` and no
`main`, `module`, `types` or `exports`. The SDK is the sibling **`@dexto/core`**, and it
is a real programmatic surface:

```
DextoAgent, defineTool, InMemoryDextoStores, createLogger
```

No dexto server, no YAML agent file, no MCP connection, no filesystem config was needed.
Construct → `start()` → `generate()` → `stop()`, entirely in-process. Whole wiring:

```ts
const agent = new DextoAgent({
  agentId, logger: createLogger({ config: {...}, agentId }),
  stores: new InMemoryDextoStores(),
  systemPrompt: '...', llm: { provider: 'ollama', model: MODEL, baseURL, temperature: 0 },
  tools: [setState, clickTrigger],
});
```

The DI surface is wider than the competition will likely be — `logger` and `stores` are
**required** constructor args, not defaulted — but `createLogger` + `InMemoryDextoStores`
are both exported, so it is four lines, not a research project.

## 2. Standalone, or needs a server/backend? — STANDALONE

Fully standalone. Nothing listened on a socket, nothing spawned. `InMemoryDextoStores`
covers the 13 store contracts the agent wants (conversation, sessions, approvals,
tool-state, …) with no database.

## 3. Live Ollama or mock? — **LIVE OLLAMA**, no mock anywhere

`ollama` is a first-class provider in dexto's LLM enum, with `supportsCustomModels: true`
and optional `baseURL`; internally it is `@ai-sdk/openai`'s `createOpenAI({...}).chat(model)`
pointed at `http://localhost:11434/v1`.

Actual output of the one decision (`bun spike/dexto/harness.ts`, 2m54s wall, cold model):

```
--- model: hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:UD-Q5_K_XL
--- raw tool calls from dexto:
[ { tool: "setState",     args: { nodeId: "email", value: "alice@example.com" } },
  { tool: "clickTrigger", args: { nodeId: "signin" } } ]
--- emitted action plan:
    setState(email, "alice@example.com")
    clickTrigger(signin)
```

Both calls reference valid Scene node ids. Success criterion met.

### Model selection was not free (two real failures first)

- **`qwen3.5:latest`** — a *thinking* model. 110s of reasoning for a 16-token reply in a
  bare curl; inside dexto it blew the turn timeout (`DextoRuntimeError: The operation
  timed out`, scope `llm`). Thinking models are a bad fit for a per-observation decision
  loop regardless of harness.
- **`qwen3-coder-ud-q4kxl` (Q4_K_M)** — deterministically emitted the tool call as *plain
  assistant text* instead of structured `tool_calls`:
  `{"name": "setState", "arguments": {...}}\n{"name": "clickTrigger", ...}`.
  I proxied dexto's actual HTTP body and replayed it against Ollama to find out why; see
  gotcha #1. Not dexto's parser — Ollama returned `finish_reason: "stop"` with the JSON in
  `content`.
- **`Qwen3-Coder-30B-A3B UD-Q5_K_XL`** — handles dexto's exact payload correctly.

## 4. Does it bundle into an MV3 service worker? — **NO.** Two builds attempted, both fail.

**Attempt A — `import { DextoAgent } from '@dexto/core'`** (the normal import; WXT/Vite
resolves the `browser` condition):

```
[MISSING_EXPORT] "DextoAgent" is not exported by ".../@dexto/core/dist/index.browser.js"
```

This is intentional on dexto's side. `dist/index.d.ts` opens with:

> *"This package is designed for server-side use (Node.js). For browser/client usage, use
> server components/actions or the API."*

`index.browser.d.ts` is 37 lines of types, enums and constants — `LLM_PROVIDERS`,
`ApprovalStatus`, `isTextPart`… There is no agent, no tool manager, no LLM service in the
browser build. The browser surface exists to let a *frontend* talk to a dexto *server*.

**Attempt B — `import { DextoAgent } from '@dexto/core/agent'`** (the `./agent` subpath has
no `browser` condition, so this smuggles the Node build in):

- 160 `has been externalized for browser compatibility` warnings
- 36 distinct Node builtins: `assert async_hooks buffer child_process crypto events fs
  fs/promises http https module net node:child_process node:readline node:stream/web
  node:zlib os path process querystring stream tls url util worker_threads zlib` (…)
- transitively drags in **winston** (file transport: `fs`/`zlib`/`os`), **google-auth-library**
  (`child_process`, `tls`, `net`), **cross-spawn**, **node-fetch**, **https-proxy-agent**
- then dies anyway:

```
[MISSING_EXPORT] "ExportResultCode" is not exported by
  "__vite-optional-peer-dep:@opentelemetry/core:@dexto/core"
  at @dexto/core/dist/telemetry/exporters.js:2
```

`DextoAgent.js` itself imports `crypto` and `events` at module top level, and
`llm/providers/codex-app-server.js` imports `node:child_process` — these are not lazy
edges you can tree-shake past.

For scale: the current background entrypoint builds to **4.79 kB**.

## 5. Node-only deps pulled? — yes, structurally

Inside `@dexto/core/dist` alone: 14×`path`, 12×`fs`, 10×`crypto`, 5×`node:fs`, 4×`os`,
plus `child_process`, `async_hooks`, `module`, `readline`. Its 25 runtime deps include
winston, boxen, chalk, glob, dotenv, `@modelcontextprotocol/sdk` and **ten** `@ai-sdk/*`
provider packages (bedrock, vertex, cohere, …) that an Ollama-only worker will never use.

## 6. Dep weight

| | |
|---|---|
| lockfile packages before / after | **569 → 721** (+152) |
| `@dexto/core` unpacked | 3.9 MB |
| extra top-level dep required | `zod@4.4.3` — a peer of `@dexto/core`, not installed by it; you must add it yourself to author tools |

## 7. Ergonomics: expressing setState + clickTrigger over the Scene

This part is genuinely pleasant — ~30 of the 142 LOC:

```ts
const setState = defineTool({
  id: 'setState',
  description: 'Converge a state node to a value...',
  inputSchema: z.object({ nodeId: z.enum(stateNodeIds), value: z.string() }),
  execute: ({ nodeId, value }) => { plan.push({ kind: 'setState', nodeId, value }); ... },
});
```

Deriving `z.enum(...)` from the Scene's node ids gives the model a closed vocabulary per
observation, which is exactly the 1:1 tool↔node mapping we want, and `generate()` hands
back `toolCalls: { toolName, args }[]` — already the action plan, no scraping of prose.
`tsc --noEmit` passes clean against the repo's strict config.

---

## Gotchas worth carrying to the other six spikes

1. **dexto injects an always-on built-in tool you cannot turn off.** `DextoAgent.start()`
   unconditionally calls `registerCoreTools([createToolOutputReadTool(...)])`
   (`agent/DextoAgent.js:323`). That one extra schema cost **+407 prompt tokens**
   (1122 vs 715 on the identical request) and was *by itself* enough to flip Q4 qwen3-coder
   from clean `tool_calls` to JSON-in-prose. Verified by diffing dexto's captured HTTP body:
   replay as-is → prose; replay with only `tool_output_read` removed → correct `tool_calls`.
   Any harness that silently pads the tool list is a liability for small local models.
2. **`endsTurn: true` on a tool crashes `generate()`** — `DextoRuntimeError: Generation
   failed: Stream did not complete successfully - no response received`. Removing it fixed
   it. Shame, because "the clickTrigger ends the decision" is exactly our semantics.
3. **Memoryless is not the default.** `generate(content, sessionId)` always goes through a
   session + conversation store; the second turn's assistant text in our run explicitly
   reasons about "the previous actions". A memoryless worker must mint a fresh `sessionId`
   per observation (cheap with `InMemoryDextoStores`, but it is opt-in, not free).
4. **Ran under `bun`, not `node`.** Node's type-stripping wants `.ts` import specifiers,
   which the repo's `moduleResolution: "Bundler"` tsconfig rejects (TS5097). Irrelevant to
   the verdict, but it is why the run command is `bun`.

## If we wanted dexto anyway

The only shape that works is **dexto out of the browser**: a local host process running
`@dexto/core`, with the MV3 service worker reduced to a transport that ships the Scene out
and pipes the action plan back. That is a different architecture from "bundle the brain
into the SW", and it trades the extension's self-containment for a daemon the user must
install — which is a product decision, not a spike finding.
