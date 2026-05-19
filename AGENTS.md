# Project Conventions

## Package Manager
- Use **pnpm** (not npm, yarn, or bun).
  - `pnpm add <pkg>` for dependencies
  - `pnpm add -D <pkg>` for dev dependencies
  - `pnpm install` to sync lockfile
- Locked to `pnpm@10.30.1` via `packageManager` field in `package.json`.

## Commands
| Command | Action |
|---|---|
| `pnpm dev` | Start WXT dev server (HMR) |
| `pnpm build` | Production build via WXT |
| `pnpm test` | Run Vitest unit tests |
| `pnpm typecheck` | Run tsc --noEmit |
| `pnpm cpd` | Run jscpd copy-paste detection |
| `pnpm test:watch` | Vitest watch mode |

## Commits
- Lefthook enforces pre-commit hooks: `tsc`, `vitest run`, `jscpd`.
- All three must pass before a commit is allowed.
