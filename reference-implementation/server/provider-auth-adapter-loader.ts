// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Split out from polyfill-connectors-runtime.ts so bundler-analyzed consumers
// of that module's other (crypto-free) exports do not also pull in this
// module's static `import()`, which reaches "node:crypto" through
// @pdpp/polyfill-connectors/provider-auth-adapters. This is the ONE export
// from the former polyfill-connectors-runtime.ts surface that is not
// webpack-safe; everything else there loads via an opaque createRequire()
// call webpack cannot follow. polyfill-connectors-runtime.ts re-exports this
// for existing consumers.

import type { ProviderAuthAdapter } from "./polyfill-connectors-runtime.ts";

// `polyfill-connectors-runtime.ts`'s other optional modules load synchronously
// via `require()`, which is fine for modules whose registration is entirely
// internal. Provider-auth adapters are different: `registerProviderAuthAdapter`
// is also called directly by test/connector code that reaches it through a
// plain ESM `import` of the same package specifier. Node does not guarantee
// that specifier resolves to the same module instance across the `require()`
// and `import()` boundaries under every loader (observed split under tsx),
// so a `require()`-loaded copy here can silently miss registrations made via
// `import` elsewhere, each side holding its own adapter registry Map. Using
// `import()` — the same loading path external registrants use — keeps this
// resolver looking at the one registry they actually wrote to.
let providerAdaptersModulePromise: Promise<Record<string, unknown> | null> | null = null;

function loadProviderAdaptersModule(): Promise<Record<string, unknown> | null> {
  providerAdaptersModulePromise ??= import("@pdpp/polyfill-connectors/provider-auth-adapters").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")) {
      return null;
    }
    throw error;
  });
  return providerAdaptersModulePromise;
}

export async function resolveProviderAuthAdapter(kind: string): Promise<ProviderAuthAdapter | null> {
  const module = await loadProviderAdaptersModule();
  const resolve = module?.resolveProviderAuthAdapter;
  return typeof resolve === "function" ? ((await resolve(kind)) as ProviderAuthAdapter | null) : null;
}
