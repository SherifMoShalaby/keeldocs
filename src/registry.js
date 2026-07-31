// Provider registry - COMPUTED from providers/*/*/provider.yaml at load time
// (src/providers.js). The v0.1 hardcoded array and its tracked-duplication
// caveat are gone: provider.yaml is the single machine-read source, so what
// ships in providers/ is exactly what runs, and a contributed provider needs
// no engine edit. A loader failure is a TOOL/CONFIG error surfaced by every
// command - never a silently smaller registry.

import { loadProviders } from "./providers.js";

export const ENGINE_VERSION = "0.2.0-dev.0";

let registry = [];
let registryError = null;
try {
  registry = loadProviders();
} catch (err) {
  registryError = String(err.message);
}

export const REGISTRY = registry;
export const REGISTRY_ERROR = registryError;
