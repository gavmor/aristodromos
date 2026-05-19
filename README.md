# aristodromos

A browser extension that implements an autonomous agent loop for page interaction using WXT.

## Architecture

The extension uses a **ReAct** (Reasoning + Acting) loop between content and background scripts:

```
┌─────────────────┐     SCENE_UPDATED     ┌──────────────────┐
│  Content Script │ ────────────────────→ │ Background Agent │
│  (per-tab)      │     (C2B, every 5s)   │  (service worker) │
│                 │ ←──────────────────── │                  │
│  - buildAXTree  │     EXECUTE_OT (B2C)  │  - AgentStrategy │
│  - apply OT     │                       │  - decideScene() │
│  - elementMap   │                       │  - recordMemory  │
└─────────────────┘                       └──────────────────┘
```

- **Content script** observes the DOM, builds an accessibility tree of interactive elements, and sends scene snapshots to the background.
- **Background script** receives scenes, decides which operations to perform (via a pluggable strategy), and sends OT (operational transform) operations back.

## Strategies

Background decisions are pluggable via the `AgentStrategy` interface:

| Strategy | Description |
|---|---|
| `RandomClickStrategy` | Picks a random clickable element. Useful for testing without an LLM. |
| `LLMStrategy` | Calls ollama (Qwen 3.6:27b) for LLM-driven decisions. |

Swap in `entrypoints/background.ts`:

```typescript
const strategy: AgentStrategy = new RandomClickStrategy();
// const strategy: AgentStrategy = new LLMStrategy();
```

## Project Structure

```
src/
├── entrypoints/
│   ├── background.ts      # Service worker — message handler + strategy dispatch
│   └── content.ts         # Content script — DOM observation + OT execution
├── utils/
│   ├── agent.ts           # Ollama client + LLM strategy
│   ├── bg-handler.ts      # Lifecycle state machine + memory
│   ├── content-handler.ts # EXECUTE_OT handler
│   ├── dom-snapshot.ts    # AX tree builder + schema distiller
│   ├── messaging.ts       # sendMessageWithAbort + isAbortError
│   ├── ot-executor.ts     # OT operation resolution + DOM application
│   ├── random-click-strategy.ts
│   ├── strategy.ts        # AgentStrategy interface
│   └── types.ts           # Shared type definitions
└── tests/                 # Vitest unit tests (57 tests, 7 files)
```

## Commands

| Command | Action |
|---|---|
| `pnpm dev` | Start WXT dev server (HMR) |
| `pnpm build` | Production build |
| `pnpm test` | Run Vitest |
| `pnpm typecheck` | TypeScript check |
| `pnpm cpd` | Copy-paste detection |

## Prerequisites

- **pnpm** 10.30.1 (locked via `packageManager`)
- For `LLMStrategy`: ollama with `qwen3.6:27b` model running on `localhost:11434`

## Testing

57 unit tests across 7 test files covering all utility modules, strategy implementations, and the pipeline integration.
