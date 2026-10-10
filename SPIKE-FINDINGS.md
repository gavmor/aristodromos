# spike(bg-harness): icepick (hatchet-dev)

**Verdict: INFEASIBLE.** Not a close call, and not for lack of trying.

`@hatchet-dev/icepick@0.1.9` is a thin LLM-flavoured wrapper over the Hatchet
distributed task engine. Its `Icepick` class literally `extends Hatchet`, and every
tool invocation — including the internal `pick-tool` step that asks the model what to
do — is dispatched as a **Hatchet workflow over gRPC to a Hatchet engine**. There is no
in-process execution path. It cannot run in an MV3 service worker, and it cannot even
make one decision on a laptop without a running engine plus Postgres.

Reproduce: `pnpm spike:icepick` (Node bundle) and `pnpm spike:icepick:sw` (MV3 probe).

---

## What was actually run

Live Ollama, no mock. Model `qwen3-coder-ud-q4kxl:latest` (tools-capable) at
`http://localhost:11434`. First call cold-loads for ~4.5 min; subsequent calls are
sub-second, so warm the model before timing anything.

The spike runs two probes over the **same** inlined Scene fixture (`spike/icepick/scene.fixture.ts`
— a login form: state node `email`, action nodes `signin` / `cancel`, inside a `loginForm`
structure node, typed against the real `utils/scene.ts`) and the **same** two tools,
`setState(nodeId, value)` and `clickTrigger(nodeId)`, whose `nodeId` enums are derived
from the Scene at runtime so the tools map 1:1 onto node ids by construction.

### [A] Control — raw Ollama tool-calling, no harness

```json
[ { "id": "call_3e2f6efv",
    "function": { "name": "setState",
                  "arguments": { "nodeId": "email", "value": "alice@example.com" } } } ]
```

The model, the Scene rendering and the Scene→tool mapping are all fine. This matters:
it means everything that fails below is icepick's infrastructure, not the brain.

### [B] icepick — construction

```
HARNESS CONSTRUCTION FAILED: API token is required. Set it via the
HATCHET_CLIENT_TOKEN environment variable. For local development, you can run
Hatchet embedded via HatchetEmbeddedClient.init() ...
```

`Icepick.init()` runs the Hatchet config loader. No token, no object — you cannot
construct the thing offline.

### [C] icepick — one decision, given its best shot

The SDK only *decodes* the token JWT (it never verifies the signature) to read engine
addresses from its claims, so the spike injects an unsigned stub token pointing at
`localhost:7070`. The client then constructs fine, and `toolbox.pickAndRun()` fails on
the honest thing:

```
harness constructed OK
🪓 [ERROR/Admin] Error: [unavailable] connect ECONNREFUSED 127.0.0.1:7070   (x8, retrying)
pickAndRun FAILED: [unavailable] connect ECONNREFUSED 127.0.0.1:7070

--- emitted actions (the deliverable of the brain) ---
(none)
```

Zero actions emitted. Worth being precise about *why*, because it is structural rather
than a missing config knob (`client/toolbox.js`):

- `toolbox.pick()` → `pickToolFactory(client).run(...)` — the LLM call is itself a
  Hatchet task, submitted to the engine and waited on.
- `toolbox.pickAndRun()` → then `tool.run(input)` per picked tool — each tool body is
  *also* a Hatchet workflow, dispatched to the engine and executed by a registered worker.

So a single memoryless decision needs: a Hatchet engine, a tenant token, **and** a
long-lived worker process (`icepick.start()`) that has registered the workflows. That is
three pieces of server-side infrastructure to answer "which button do I press".

---

## Standalone, or needs a server?

**Needs a server.** Unambiguously.

The error message advertises an escape hatch — `HatchetEmbeddedClient.init()` from
`@hatchet-dev/typescript-sdk/v1/embedded` — but reading `v1/embedded.d.ts` shows it is
not an in-process mode. It **downloads a native Go sidecar binary** (release tag,
sha256 checksum pinning, `binaryPath` override) and **spawns it with a bundled
Postgres**, then hands back a client pointed at `localhost`:

> `startEmbeddedSidecar()` — *"Downloads (and caches) the hatchet-embedded sidecar
> binary, spawns it, and waits until the embedded engine is ready."*
> Options include `databaseUrl`, `postgresDataDir`, `grpcPort`, `apiPort`, `runMigrations`.

Process spawning and Postgres are not available to a service worker, so "embedded" does
not rescue the MV3 story. (It also returns a plain `HatchetClient`, not an `Icepick`, so
you would additionally have to re-route the token into `Icepick.init()` to get the
`agent`/`tool`/`toolbox` API back.)

## Bundles into an MV3 service worker?

**No.** `pnpm spike:icepick:sw` bundles a file whose entire content is
`import { Icepick } from '@hatchet-dev/icepick'`, with `esbuild --platform=browser`:

**52 errors, 23 distinct unresolvable Node builtins:**

```
async_hooks  crypto  dns   events  fs    http   http2  https  net   os
path  process  stream  tls  url  util  worker_threads  zlib
node:http  node:http2  node:https  node:util  node:zlib
```

`net`, `tls`, `dns` and `http2` are the fatal ones: that is gRPC wanting raw TCP sockets
and HTTP/2, which no polyfill can provide in a service worker. There is no "swap in a
browser transport" version of this — `@grpc/grpc-js` is Node-only by design. A WXT build
attempt was not worth the minutes; the dependency graph settles it.

## Node-only deps pulled

`@hatchet-dev/typescript-sdk@1.37.0` (5.6M) → `@grpc/grpc-js@1.14.6` (4.6M) +
`protobufjs@7.6.6` (3.3M) + `axios` + OpenTelemetry. Plus `ai@4.3.19` (2.5M) and
`@ai-sdk/openai@1.3.24` (1.2M), which icepick needs but does not re-export, so you
supply them yourself.

## Dep weight

`pnpm` resolved **505 → 634 packages (+129)** to add one import. icepick's own code is
**108K**; its mandatory runtime is ~15M of gRPC/protobuf/OTel/axios/ai-sdk.

Two supply-chain notes:

- icepick pins `ai@^4.3.16`. `ai@4.3.19` carries **GHSA-rwvc-j5jr-mgvh / CVE-2025-48985**
  (low, 3.7 — filetype-whitelist bypass on upload). Patched in `ai@5.0.52`, which
  icepick's caret range cannot reach. Irrelevant to our use (no uploads) but it is an
  advisory you inherit and cannot resolve without icepick shipping a v5 bump.
- The `ai` v4 line means `LanguageModelV1`. `@ai-sdk/openai@4.x` and `ai@5.x` are
  `LanguageModelV2` and will not typecheck against it, so adopting icepick pins the
  whole AI-SDK surface to a superseded major.

## LOC / ergonomics for setState + clickTrigger

Credit where due: **the authoring API is genuinely nice.** Zod in, Zod out, tool name
preserved as a literal type so `pickAndRun` returns a discriminated union you can
`switch` on, with `assertExhaustive()` for the default arm. Expressing both tools over
the Scene took ~45 lines:

```ts
const setState = icepick.tool({
  name: 'setState',
  description: 'Set the value of a convergent state node in the Scene...',
  inputSchema: z.object({ nodeId: asEnum(STATE_IDS), value: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  fn: async (input) => { emitted.push({ tool: 'setState', ...input }); return { ok: true }; },
});
const toolbox = icepick.toolbox({ tools: [setState, clickTrigger] as const });
await toolbox.pickAndRun({ prompt });   // <- this is the line that needs a cluster
```

Deriving the `nodeId` enums from the Scene makes "tools map 1:1 onto Scene nodes"
mechanical, and the narrowed return type is exactly the shape the bg worker wants.

Semantics are also a decent fit on paper — Hatchet gives at-least-once with durable
retries for free, which is our stated delivery model. The cost of that freebie is the
entire engine.

## Verdict

**Infeasible.** icepick is an orchestration client, not a decision loop: `pickAndRun`
dispatches both the model call and every tool body as Hatchet workflows over gRPC, so one
memoryless decision requires an engine, a tenant token and a registered worker — and its
"embedded" mode is a downloaded Go binary plus Postgres, not an in-process library.
Bundling it for MV3 fails on 23 Node builtins, `net`/`tls`/`dns`/`http2` among them, which
is unfixable by polyfill.

The control probe is the real lesson: the decision we want took one `fetch` to
`/api/chat` with two tool schemas derived from the Scene, and returned
`setState(email, "alice@example.com")` correctly. Against that baseline, +129 packages
and a Postgres-backed engine buy us durable retries we do not need in a service worker
that already has at-least-once semantics from the content-script edge. If icepick's
ergonomics are what appeal, lift the *pattern* — Zod-schema'd tools with literal names
and an exhaustive result union — onto a direct AI-SDK or raw-`fetch` call, which is
exactly what `spike/ai-sdk-ollama` should be measuring.

---

### Files

| path | what |
|---|---|
| `spike/icepick/scene.fixture.ts` | inlined login-form Scene + node-id/prompt helpers |
| `spike/icepick/run.ts` | control probe, icepick harness, one decision |
| `spike/icepick/sw-probe.ts` | MV3 bundlability probe |

Throwaway branch. Do not merge.
