# spike(bg-harness): RunMesh (iluxu)

**Verdict: infeasible — as published.** Reconsider only if upstream ships a release that
is actually installable.

RunMesh's *ideas* fit aristodromos well: a thin, dependency-light, OpenAI-shaped tool loop
with a pluggable client — exactly the shape the bg worker needs. But `0.1.0-alpha.1` is
**broken on npm**: not one of the nine `@runmesh/*` packages can be imported by its own
published entry point. Getting a single decision out of it took four separate workarounds,
two of which patch around the vendor rather than configure it. The working core underneath
is ~10 KB of real logic; everything else that made this run is scaffolding we would own
and maintain forever.

---

## What was proven

With the workarounds in place, the harness **does** do the job. One decision, live Ollama
(`qwen3-coder-ud-q4kxl:latest`, 30.5B A3B), goal *"sign in as alice@example.com"*:

```
[spike] emitted actions:
  1. setState(email, "alice@example.com")
  2. clickTrigger(signin)

[spike] 4 steps (2 tool calls)
[spike] final: "The sign-in process has been completed successfully. I've entered the
                email address alice@example.com and clicked the sign-in button."
[spike] all emitted node ids valid: true
```

Structured actions, correct order, every `nodeId` a real Scene node. **Live Ollama, not a
mock.** Reproduce with `pnpm spike:runmesh`.

Reliability after the schema fix (workaround 3): **15 / 18 runs** emitted the exact pair
above. The 3 failures were consecutive in one early batch and all had the same shape — the
model answered with the tool calls as *prose JSON* instead of `tool_calls`, so the loop
saw nothing to execute. The last 13 runs were clean (`bash spike/reliability.sh N`).
RunMesh exposes no `temperature` or `tool_choice` passthrough on `AgentExecutor`, so there
is no supported way to stabilise that from the harness side.

---

## The four workarounds

### 1. The published packages do not import — at all

Every `@runmesh/*` package declares:

```json
"main": "dist/index.js",  "types": "dist/index.d.ts",
"exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }
```

but the tarball contains no `dist/index.js`. `tsc -b` ran without a `rootDir`, so the emit
landed at `dist/framework/packages/<pkg>/src/index.js` — the monorepo's own path shape,
published verbatim. The advertised entry point is simply absent.

```
$ node spike/probe-resolve.mjs
FAIL @runmesh/core  -> ERR_MODULE_NOT_FOUND: .../node_modules/@runmesh/core/dist/index.js
FAIL @runmesh/agent -> ERR_MODULE_NOT_FOUND: .../node_modules/@runmesh/agent/dist/index.js
FAIL @runmesh/tools -> ERR_MODULE_NOT_FOUND: .../node_modules/@runmesh/tools/dist/index.js
```

This is not survivable by deep-importing, because the packages' *internal* cross-imports
are bare specifiers that re-enter the same broken `exports` gate:

```
$ node spike/probe-deep.mjs
OK   deep @runmesh/core  -> createOpenAI, buildJsonSchema, ...
FAIL deep @runmesh/tools -> ERR_MODULE_NOT_FOUND: .../@runmesh/schema/dist/index.js
FAIL deep @runmesh/agent -> ERR_MODULE_NOT_FOUND: .../@runmesh/core/dist/index.js
```

Only `core` (the one leaf with no `@runmesh` siblings) survives. The agent layer — the part
we actually want — is unreachable.

`spike/runmesh-resolve-hook.ts` is the workaround: a Node `registerHooks` resolver that
rewrites `@runmesh/*` to the real emit path. It cannot delegate to `nextResolve` and patch
the result, because Node throws *while* resolving the missing exports target, so it has to
re-implement the node_modules walk. The same breakage hits TypeScript (`types` points at
the same missing file) and any bundler — hence `paths` in `tsconfig.typecheck.json` and
`--alias` in `spike/bundle-mv3.sh`. Under pnpm's strict layout `@runmesh/schema` and
`@runmesh/memory` are transitive-only, so those aliases must reach into `node_modules/.pnpm`
internals — not something to ship.

### 2. `Agent` cannot be pointed at Ollama

`AgentConfig` is `{ name, model, systemPrompt?, tools?, memory?, policies? }` — no
`baseURL`, no `apiKey`, no client injection. And `Agent`'s constructor hardcodes:

```js
const client = createOpenAI({ defaultModel: config.model });   // agent.js
```

`createOpenAI` *does* accept `baseURL`, but `Agent` never passes one, so the documented
entry point (`createAgent`) can only ever reach `api.openai.com`. For a local-model project
the headline API is unusable.

The escape hatch is real but undocumented: `AgentExecutor` takes `client` directly, so the
spike builds `createOpenAI({ baseURL: 'http://localhost:11434/v1', ... })` itself and skips
`Agent` entirely. That path works — the OpenAI-compat route to Ollama is fine. Note
`createOpenAI` defaults to a **30 s timeout**; a cold 30B load blew through it on the first
run, so the spike warms the model and passes `timeout: 300_000`.

### 3. Tool schemas ship as `$ref` indirection, and the model guesses argument names

`toOpenAITool()` passes `zod-to-json-schema`'s default output straight through:

```json
"parameters": { "$ref": "#/definitions/setState",
                "definitions": { "setState": { "type": "object", "properties": {...} } } }
```

OpenAI's function-calling contract wants a flat object schema. Local engines render the
indirection opaquely, so the model never sees the property names. Controlled A/B at
`temperature: 0`, same model, same prompt (`spike/probe-schema-shape.ts`):

```
RunMesh $ref-wrapped schema:  {"id":"email","value":"alice@example.com"}      correct: false
inlined flat schema        :  {"value":"alice@example.com","nodeId":"email"}  correct: true
```

The `$ref` form makes the model invent `id` instead of `nodeId`. Which leads directly to:

### 4. One bad tool argument kills the entire run

`ToolExecutor.execute` zod-validates arguments and lets the `ZodError` escape. There is no
per-tool error channel, no feedback to the model, no repair round. The wrong-argument-name
behaviour from (3) therefore crashed the whole decision:

```
ValidationError: Data validation failed
  at assertValid (@runmesh/schema/.../validation.js:14:15)
  at ToolExecutor.execute (@runmesh/tools/.../executor.js:15:23)
  at AgentExecutor.handleToolCalls (@runmesh/agent/.../executor.js:76:52)
  cause: ZodError: [{ "path": ["nodeId"], "message": "Required" }]
```

For a memoryless, at-least-once bg worker this is the wrong default: a hallucinated
argument should be a tool result the model can correct, not an exception that takes down
the turn. `spike/runmesh-spike.ts` works around (3) by inlining the schema, which makes (4)
stop firing — but (4) remains the behaviour whenever a model gets an argument wrong.

### Bonus defect: the advertised tool workflow does not typecheck

`ToolRegistry.register(tool: RegisteredTool)` defaults its generics to
`RegisteredTool<unknown, unknown>`, and `handler: (input: TInput, ...)` puts `TInput` in a
contravariant position. So *nothing* `tool()` returns is assignable to what `register()`
accepts — `tool()` + `register()`, the core advertised workflow, fails under `strict`:

```
error TS2345: Argument of type 'RegisteredTool<{ nodeId: string; }, ...>' is not
assignable to parameter of type 'RegisteredTool'.
      Type 'unknown' is not assignable to type '{ nodeId: string; }'.
```

`register` would have to be generic. Every consumer must cast. Four casts in this spike.

---

## Deliverable questions

| Question | Answer |
|---|---|
| Standalone, or needs a server? | **Standalone.** Pure library, no daemon, no CLI, no backend. |
| Bundles into an MV3 service worker? | **Yes, mechanically.** `--platform=browser --target=chrome120` → 402 KB ESM, **0 `node:` builtins, 0 `require(`**. |
| Node-only deps pulled? | **None.** Only `openai`, `zod`, `zod-to-json-schema`. One latent `process.env.OPENAI_API_KEY` read, short-circuited by `config.apiKey \|\|` — safe if you always pass `apiKey`, a `ReferenceError` in a SW if you ever don't. |
| Dep weight | 402 KB raw: **zod 100 KB (25%)**, openai SDK ~170 KB, zod-to-json-schema ~20 KB. **RunMesh's own code is ~10 KB** (`agent/executor.js` is 3.4 KB). We would be bundling the OpenAI SDK to talk to localhost. |
| LOC / ergonomics for setState + clickTrigger | **~45 LOC** for the two tools incl. Scene-node validation — genuinely terse, and `tool({name, description, schema, handler})` is a good shape. But add ~50 LOC of vendor workaround (resolve hook) + ~20 LOC of schema flattening + 4 casts before any of it runs. |
| Live Ollama or mock? | **Live Ollama**, `qwen3-coder-ud-q4kxl:latest`, OpenAI-compat endpoint. No mock anywhere. |

## Why "infeasible" and not "feasible-with-caveats"

The loop works, so this is not a capability judgement — it's a maintenance one. Defect (1)
means we cannot consume the package as a dependency at all without shipping a resolver
shim, a `tsconfig` paths table, and bundler aliases that reach into `node_modules/.pnpm`
internals. That is vendoring with extra steps, and it breaks on any pnpm layout change.
Defects (2)–(4) plus the typing bug say the API has not been exercised by anyone against a
non-OpenAI backend, or under `strict`, or with a model that gets an argument wrong.

And the thing we would be buying is ~10 KB: a `while (tool_calls)` loop, a `Map` registry,
and a zod→JSON-Schema call. Against 400 KB of transitive weight and four permanent
workarounds, writing that loop directly against Ollama's `/v1/chat/completions` is smaller,
typed, and ours.

**Revisit if** upstream publishes a version whose `exports` resolve, `createAgent` accepts
a `baseURL`, and `toOpenAITool()` inlines the schema. The design is sound; the release is not.

---

## Files

| Path | What |
|---|---|
| `spike/runmesh-spike.ts` | The spike. Scene → tools → one decision → printed actions. |
| `spike/scene-fixture.ts` | Inlined login-form Scene, typed against the real `utils/scene.ts`. |
| `spike/runmesh-resolve-hook.ts` | Workaround 1: Node resolver shim for the broken `exports`. |
| `spike/probe-resolve.mjs` | Evidence: published entry points fail. |
| `spike/probe-deep.mjs` | Evidence: deep imports cascade-fail on sibling packages. |
| `spike/probe-schema-shape.ts` | Evidence: `$ref` vs inlined schema, A/B at `temperature: 0`. |
| `spike/probe-toolcalls.ts` | Evidence: raw Ollama accepts RunMesh's tool payload. |
| `spike/mv3-entry.ts` + `bundle-mv3.sh` | MV3 service-worker bundling probe. |
| `spike/reliability.sh` | Runs the decision N times, counts structured-action successes. |

Repo changes beyond `spike/`: `@runmesh/{agent,core,tools}` + `zod` + `@types/node` in
`package.json`, and the `@runmesh/*` `paths` block in `tsconfig.typecheck.json` (without
which `tsc` cannot see the packages). **Throwaway — do not merge.**
