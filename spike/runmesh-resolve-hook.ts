// Routes around RunMesh's broken packaging (see SPIKE-FINDINGS.md).
//
// Every @runmesh/* package publishes `exports: { ".": "./dist/index.js" }`, but
// `tsc -b` actually emitted to `dist/framework/packages/<pkg>/src/index.js`.
// The advertised entry point does not exist in the published tarball, so a plain
// `import '@runmesh/core'` dies with ERR_MODULE_NOT_FOUND. The packages' own
// internal cross-imports use bare specifiers, so the breakage cascades: even a
// deep import of @runmesh/agent dies at its `from "@runmesh/core"`.
//
// Node's resolver throws while resolving the (nonexistent) exports target, so we
// cannot delegate to nextResolve and patch the result — we have to intercept the
// bare specifier and walk node_modules ourselves.
//
// This exists purely so the spike can evaluate the API behind the packaging bug.
import { registerHooks } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const RUNMESH = /^@runmesh\/([a-z]+)$/;

/** Real emit path for `pkg`, found by walking node_modules up from `fromUrl`. */
function locateRealEmit(pkg: string, fromUrl: string): string | null {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = join(
      dir,
      'node_modules',
      '@runmesh',
      pkg,
      'dist/framework/packages',
      pkg,
      'src/index.js',
    );
    if (existsSync(candidate)) return pathToFileURL(realpathSync(candidate)).href;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function installRunMeshResolveShim() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const m = RUNMESH.exec(specifier);
      if (!m || !context.parentURL) return nextResolve(specifier, context);
      const url = locateRealEmit(m[1]!, context.parentURL);
      if (!url) return nextResolve(specifier, context);
      return { url, format: 'module', shortCircuit: true };
    },
  });
}
