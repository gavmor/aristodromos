# spike(bg-harness): calfkit-sdk (calf-ai)

**Verdict: INFEASIBLE.** Calfkit is a Python-only, Kafka-native framework. There is no
JavaScript/TypeScript distribution to depend on, so it cannot be added to this package —
let alone bundled into an MV3 service worker. The spike stopped at step 1 of the card.

Spike date: 2026-10-09. Version examined: `calfkit` 0.13.0 (PyPI) / `calf-ai/calfkit-sdk`
@ `main`. Re-run the evidence with `spikes/calfkit/verify-availability.sh`.

---

## The blocker, in one line

The card requires "TypeScript; bundlable into an MV3 service worker". Calfkit ships
`requires-python >=3.10` and is installed with `pip install 'calfkit[mesh]'`.
Wrong ecosystem — the mismatch is categorical, not an API-ergonomics problem.

## Evidence

### 1. No npm package exists, under any plausible name

All seven candidate names 404 against the public registry, and `npm search calfkit`
returns `[]`:

| name | result |
|---|---|
| `calfkit-sdk` | E404 |
| `calfkit` | E404 |
| `calf-ai` | E404 |
| `@calf-ai/sdk` | E404 |
| `@calfkit/sdk` | E404 |
| `calf-sdk` | E404 |
| `calfkit-ai` | E404 |

The sole distribution is PyPI [`calfkit`](https://pypi.org/project/calfkit/) 0.13.0.
Repo root holds `pyproject.toml`, `uv.lock`, and `src/calfkit/`; the build backend is
`uv_build`. There is no `package.json`.

> **Trap for the side-by-side reviewer:** GitHub's language bar reports
> **JavaScript 13,925 B** for this repo, which looks like a JS distribution at a glance.
> It is not. The repo contains exactly two JavaScript files, both agent-skill helper
> scripts committed under `.agents/skills/brainstorming/scripts/` (`helper.js`,
> `server.cjs`) — tooling for the maintainers' own coding agents, unrelated to the SDK
> surface. Every line of the SDK is under `src/calfkit/` in Python.

### 2. Known risk — "may assume a broker/runtime" — CONFIRMED, and stronger than stated

The card asked us to confirm or refute whether Calfkit can run a single in-process
decision without external infrastructure. It cannot:

- The **base** install of 0.13.0 — not an extra — depends on `faststream[kafka]>=0.7.1,<0.8`.
  A Kafka client is in the mandatory dependency set.
- The "zero-setup" local dev path is the `[mesh]` extra, which pulls `calfkit-mesh` plus
  `psutil`. `calfkit-mesh` describes itself as a *"vendored, memory-only Kafka-compatible
  broker **binary** for local calfkit development."* Even the zero-setup story ships a
  compiled, platform-specific broker executable.
- The execution model is `Worker` + `Client.connect("localhost:9092")` + a `ck dev run` /
  `ck dev chat` CLI. The unit of work is a long-lived node subscribed to topics, not a
  callable decision function. There is no documented single-shot, broker-free entry point.

So even in a hypothetical TypeScript port, the architecture is the opposite of what the
bg worker needs: Calfkit is built for durable, multi-hop, at-least-once choreography
across independently deployed services, whereas this harness needs one memoryless,
in-process `Scene -> action` call.

### 3. Secondary: the published version and `main` have diverged

`main`'s `pyproject.toml` currently declares `dependencies = []` — a rewrite is in flight.
The README states docs for 0.13 live on the `legacy/0.13` branch and that "docs for the
rewrite are being written from scratch." Project maturity is `Development Status :: 3 - Alpha`.
Even setting the language barrier aside, the API is unstable right now.

---

## Deliverable questions, answered

| Question | Answer |
|---|---|
| Standalone, or needs a server/backend? | **Needs a broker.** `faststream[kafka]` is a base dep; the dev mesh is a vendored native broker binary. |
| Bundles into an MV3 service worker? | **No.** Python package; nothing to bundle. |
| Node-only deps pulled? | **N/A — worse.** Not Node at all. Native/platform deps (`psutil`, vendored broker binary) on the Python side. |
| LOC / ergonomics for `setState` + `clickTrigger` over the Scene? | **Not reached.** Card steps 2, 3 and 5 are unexecutable without an installable dependency. No Scene fixture or tool registration was written — that absence is a consequence of the blocker, not an omission. |
| Dep weight | **N/A.** 0 bytes added to this package; nothing was installed. `pnpm-lock.yaml` is untouched. |
| Live Ollama or mock? | **Neither — no decision was run.** See isolation note below. |

### Isolation note: the environment was ready; Calfkit was the blocker

So this verdict is not confused with a local setup failure, the model side was verified
healthy before the spike stopped:

- Ollama live and answering at `http://localhost:11434/api/tags`.
- Tool-capable Qwen models present and ready, e.g. `qwen3.5:latest` and
  `qwen3-coder-ud-q4kxl:latest` (both advertise the `tools` capability).

Nothing about Ollama, Qwen, TypeScript or WXT obstructed this spike. The only obstruction
was that `calfkit-sdk` does not exist as a JavaScript dependency.

---

## Verdict

**Infeasible.** Calfkit is a Python, Kafka-native framework for deploying agents as
independently scaled microservices over a message mesh; it is distributed only on PyPI and
carries a broker (and a native broker binary) in its mandatory install. It cannot be added
to this TypeScript package, cannot be bundled into an MV3 service worker, and its
choreography-over-durable-streams model is architecturally mismatched with a memoryless,
single-shot, in-process `Scene -> action` decision anyway.

The only shape in which Calfkit could ever touch this project is as an out-of-process
Python sidecar reached over HTTP or native messaging — which violates the card's stated
constraint of bundling the brain into the service worker, and buys nothing a plain HTTP
call to Ollama does not already provide. **Recommend dropping it from the comparison.**
