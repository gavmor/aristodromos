// THROWAWAY SPIKE — MV3 bundlability probe.
//
// Bundled with `esbuild --platform=browser --format=esm` to answer: what does
// pulling @hatchet-dev/icepick into a service worker actually drag in?
import { Icepick } from '@hatchet-dev/icepick';

export function probe(): string {
  return typeof Icepick;
}
