# SPIKE FINDINGS — Vercel AI SDK + Ollama as the bg-worker brain

**Verdict: FEASIBLE, with one dependency caveat and one model caveat.**

Branch `spike/ai-sdk-ollama`. Throwaway, happy-path only. Do not merge.

---

## What was built

`spike/ai-sdk-ollama/` — 354 lines total, 106 of them non-comment in the brain itself:

| file | what |
|---|---|
| `scene-fixture.ts` | inline login-form `Scene` (one `state` node `email`, two `action` nodes `signin`/`cancel`, plus the enclosing form) |
| `brain.ts` | the whole harness: Scene → prompt → tool loop → `EmittedAction[]` |
| `run.ts` | one decision, printed; live Ollama with a canned-mock fallback |
| `repeat.sh` | runs N decisions against one model and tallies structured-tool-call rate |

Run it:

```
node spike/ai-sdk-ollama/run.ts                                  # live ollama
OLLAMA_MODEL=qwen3-coder-ud-q4kxl:latest node spike/.../run.ts   # pick a model
SPIKE_FORCE_MOCK=1 node spike/ai-sdk-ollama/run.ts               # no ollama needed
```

---

## Observed result (LIVE Ollama, not mocked)

Ollama was reachable throughout; every number below is from a real
`http://localhost:11434` call. The mock path exists and was verified separately
(`SPIKE_FORCE_MOCK=1`), but it is **not** the basis of this verdict.

```
[spike] LIVE ollama — model qwen3.5:latest
[spike] goal: sign in as alice@example.com
[spike] steps: 2  elapsed: 77394ms
[spike] emitted actions:
  setState(email, "alice@example.com")
  clickTrigger(signin)
[spike] final text: I signed in as alice@example.com by setting the email field and clicking the sign in button.
[spike] all emitted ids resolve to real Scene nodes ✓
```

That is the success condition from the card: structured actions, in the right
order, referencing real Scene node ids.

---

## Answers to the deliverable questions

**Standalone, or does it need a server/backend?**
Standalone. `ai` is a library, not a runtime — no sidecar, no daemon, no broker.
The only external process is Ollama itself, which is a given.

**Does it bundle into an MV3 service worker?**
Yes — verified, not assumed. Importing `brain.ts` into `entrypoints/background.ts`
and running `pnpm build` produced a working `chrome-mv3` build:

| | background.js |
|---|---|
| baseline (no brain) | 4.79 kB |
| with the brain | 310.35 kB raw / **82.6 kB gzipped** |

So the brain costs ~**305 kB raw / ~78 kB gzip** inside the service worker.
Not free, but nowhere near an MV3 problem.

(That `background.ts` import was a temporary probe and has been reverted — the
committed diff leaves the real background entrypoint untouched. To reproduce,
add `import { decide } from '../spike/ai-sdk-ollama/brain';` to
`entrypoints/background.ts` and run `pnpm build`.)

**Node-only deps pulled?**
No hard ones. The bundle does contain four `node:` strings, so I checked each
rather than trusting the build's silence. They are all behind a runtime guard:

```js
function Wu(){let e=globalThis.process;return e?.release?.name===`node` && … }
```

In a service worker `globalThis.process` is undefined, `Wu()` returns false, and
the code falls through to `globalThis.fetch`. `node:dns`/`node:module` (an undici
fast path) and `node:async_hooks`/`node:diagnostics_channel` (optional telemetry)
are dead code in MV3. **Confirms the card's risk: SW `fetch` to localhost:11434 is
the path actually taken.**

**Ergonomics — LOC to express setState + clickTrigger over the Scene?**
Low. The tool loop is `generateText({ model, system, prompt, tools, stopWhen })`,
and `stopWhen: [stepCountIs(6)]` *is* the entire loop controller — this confirms
the card's second open question. The two tools are ~15 lines each.

The one idea worth stealing regardless of which harness wins: build the tool
schemas **from** the Scene, so the node-id argument is a `z.enum` of the ids
actually present.

```ts
const stateIds = Object.values(scene.nodes).filter(isState).map(n => n.id);
inputSchema: z.object({ nodeId: z.enum(asTuple(stateIds)), value: z.string() })
```

A hallucinated node id becomes a schema violation inside the SDK instead of a
dangling reference the content script has to reject. Grounding is enforced by
the harness, not hoped for from the model. `execute` only *records* the intent —
the content script still owns actuation, which keeps the loop safe to retry
(at-least-once).

`import type { Scene } from '../../utils/scene'` compiles away to nothing, so the
brain speaks the real up-edge contract with zero runtime coupling.

**Dep weight?**
`ai@7.0.137`, `ollama-ai-provider-v2@4.0.1`, `zod@4.6.5` → 16 packages added,
~305 kB raw / ~78 kB gzip in the SW bundle.

**Bonus — no build step needed to run it.** Node 26 strips types natively, so
`node spike/ai-sdk-ollama/run.ts` just works: no tsx, no ts-node, no esbuild.
(Cost: one line, `allowImportingTsExtensions`, added to `tsconfig.typecheck.json`
so the `.ts`-suffixed relative imports Node needs also satisfy tsc.)

---

## Caveat 1 — `ollama-ai-provider` is dead; use `ollama-ai-provider-v2`

The card names `ollama-ai-provider`. **That package cannot be used with a current
AI SDK**, and this is worth flagging to the other six spikes since several may
reach for the same name.

- `ollama-ai-provider@1.2.0` (latest) → `@ai-sdk/provider@^1.0.0`, peer `zod@^3`
- `ai@7.0.137` → `@ai-sdk/provider@4.0.26`

Installed as written, pnpm immediately objects:

```
└─┬ ollama-ai-provider 1.2.0
  ├── ✕ unmet peer zod@^3.0.0: found 4.6.5
```

and `tsc` refuses the model outright:

```
error TS2322: Type 'LanguageModelV1' is not assignable to type 'LanguageModel'.
  Property 'supportedUrls' is missing in type 'LanguageModelV1'
  but required in type 'LanguageModelV2'.
```

`ollama-ai-provider-v2@4.0.1` is the maintained successor (`@ai-sdk/provider@^4`,
peer `ai@^7`), advertises web/edge compatibility, and has exactly 2 dependencies.
Swapping to it is a one-line import change and everything above then works. The
v1 package has been removed from `package.json`; the evidence lives here.

Two API names also moved under the card's assumptions: `stepCountIs` is exported
but is `isStepCount` internally, and **`Agent` is a type in `ai@7`, not a
constructible class** — there is no `new Agent(...)`. `generateText` + `stopWhen`
is the loop.

## Caveat 2 — the bottleneck is the model, not the harness

Same harness, same fixture, same goal; only the model changed. `repeat.sh`:

| model | thinking | structured tool calls | latency, warm, 2 steps |
|---|---|---|---|
| `qwen3-coder-ud-q4kxl:latest` (30B A3B) | no | **4 / 6** | 3.2 – 5.9 s |
| `qwen3.5:latest` (9.7B) | yes | **3 / 3** | 55 – 180 s (337 s cold) |

The two available Qwens fail in opposite directions, and neither is comfortable:

1. **The reliable model is far too slow for a per-observation decision loop.**
   `qwen3.5` never missed a tool call, but a single two-step decision costs a
   minute or more — for a bg worker reacting to a live Scene that is a
   non-starter. (These were measured on a busy GPU, so treat the 180 s as a
   loaded upper bound rather than a clean figure; even the 55 s best case makes
   the point.)
2. **The fast model drops tool calls.** On 2 of 6 runs `qwen3-coder` printed the
   calls as plain text in the assistant message instead of emitting structured
   tool calls:

   ```
   [spike] emitted actions:
     (none — the model answered without calling a tool)
   [spike] final text: {"name": "setState", "arguments": {"nodeId": "email", …}}
   ```

   This is Ollama's GGUF chat-template tool parsing, not the AI SDK — the SDK
   faithfully reported zero tool calls. But **whichever harness wins will need a
   retry/repair path for it**, so it should be part of the comparison rather than
   a surprise later.

   (My first version of the runner printed a green ✓ on these runs, because
   "no ungrounded ids" is vacuously true when there are no ids. Fixed — an empty
   action list is now reported as `FAIL`. Worth watching for in the sibling
   spikes: the same vacuous-pass shape is easy to write.)

Neither axis is the AI SDK's doing, and every competing harness calling the same
local Ollama will inherit both. The open product question this surfaces — which
is bigger than this spike — is whether the bg loop gets a fast non-thinking model
plus a repair path, or a different model entirely.

---

## Verdict

**Feasible-with-caveats, and a credible control for the other six.** The AI SDK is
a plain fetch-based library that bundles into an MV3 service worker for ~78 kB
gzip with no hard Node dependency, and `generateText` + `stopWhen` + Scene-derived
`zod` tool schemas express setState/clickTrigger in about 100 lines with
hallucinated node ids made structurally impossible. The caveats are a stale
package name (`ollama-ai-provider` → `ollama-ai-provider-v2`) and local tool-call
reliability of ~4/6 on the fastest tool-capable Qwen available here — and the
reliable alternative is ~60 s per decision. That latency/reliability squeeze is
a model and Ollama problem every competing harness in this comparison will
share, so it is a baseline fact rather than a mark against this option.
