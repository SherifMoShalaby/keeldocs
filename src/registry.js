// Provider registry - COMPUTED from providers/*/*/provider.yaml at load time
// (src/providers.js). The v0.1 hardcoded array and its tracked-duplication
// caveat are gone: provider.yaml is the single machine-read source, so what
// ships in providers/ is exactly what runs, and a contributed provider needs
// no engine edit. A loader failure is a TOOL/CONFIG error surfaced by every
// command - never a silently smaller registry.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProviders } from "./providers.js";

// Read from package.json rather than restated here. A hand-maintained copy went
// stale and shipped: 0.2.0-rc.4 on npm carried ENGINE_VERSION "0.2.0-dev.0", and
// that string is stamped into meta.engine on every receipt `check` emits - the
// drift detector misreporting its own version in the evidence it asks users to
// trust. This is a file read at load time, not in the check path: no network, no
// clock, still a pure function of the tree. Pinned by a unit test.
export const ENGINE_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

let registry = [];
let registryError = null;
try {
  registry = loadProviders();
} catch (err) {
  registryError = String(err.message);
}

export const REGISTRY = registry;
export const REGISTRY_ERROR = registryError;
