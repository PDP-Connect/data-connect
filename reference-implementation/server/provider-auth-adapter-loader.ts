// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Split out from polyfill-connectors-runtime.ts so bundler-analyzed consumers
// of that module's other (crypto-free) exports do not also pull in this
// module's static `import()`, which reaches "node:crypto" through
// @pdpp/polyfill-connectors/provider-auth-adapters. This is the ONE export
// from the former polyfill-connectors-runtime.ts surface that is not
// webpack-safe; everything else there loads via an opaque createRequire()
// call webpack cannot follow. polyfill-connectors-runtime.ts does NOT
// re-export this (see the comment left there): a re-export would put this
// module's value-import graph — and its node:crypto reach — right back on
// polyfill-connectors-runtime.ts's. Consumers import directly from here.

import type { ProviderAuthAdapter } from "./polyfill-connectors-runtime.ts";

/**
 * The dynamic `import()` below rejecting means one of two very different
 * things: the optional package (or this subpath of it) is not installed —
 * `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`, this loader's only "no adapters
 * available" case, mapped to `null` — or a real failure (a syntax error in
 * the package, a broken transitive dependency, disk/permission trouble),
 * which must re-throw so it surfaces as a loud error, never a silent
 * `undefined` a caller could mistake for "no adapter for this kind".
 *
 * Extracted to one expression (rather than left inline in `.catch(...)`) and
 * exported so a test can call it directly with a synthetic error, proving
 * both branches without needing to force the real import to fail — the real
 * import only fails the "not installed" way in an environment missing the
 * package entirely, which a unit test cannot construct without module
 * mocking.
 */
export function moduleNotFoundFallback(error: unknown): null {
  if (error instanceof Error && "code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")) {
    return null;
  }
  throw error;
}

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
  providerAdaptersModulePromise ??= import("@pdpp/polyfill-connectors/provider-auth-adapters").catch(moduleNotFoundFallback);
  return providerAdaptersModulePromise;
}

/**
 * `loadModule` is injectable so a test can supply a module shape (or a
 * rejection) directly, without needing to redirect the hardcoded package
 * specifier above or mock `import()`. Production code never passes it; the
 * default always goes through the real loader, so this seam changes no
 * production behavior.
 */
export async function resolveProviderAuthAdapter(
  kind: string,
  loadModule: () => Promise<Record<string, unknown> | null> = loadProviderAdaptersModule
): Promise<ProviderAuthAdapter | null> {
  const module = await loadModule();
  const resolve = module?.resolveProviderAuthAdapter;
  return typeof resolve === "function" ? ((await resolve(kind)) as ProviderAuthAdapter | null) : null;
}
