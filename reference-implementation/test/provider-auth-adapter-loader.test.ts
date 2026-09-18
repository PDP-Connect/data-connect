// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for provider-auth-adapter-loader.ts, split out of
 * polyfill-connectors-runtime.ts so that module's other (crypto-free) value
 * exports stop dragging a webpack-visible `node:crypto`-reaching import into
 * the console bundle (see that module's header comment and the PR this
 * shipped in). Three properties matter here, none proven elsewhere:
 *
 *   1. `moduleNotFoundFallback` distinguishes "the optional package is not
 *      installed" (swallow to null) from every other failure (rethrow) —
 *      the exact distinction PR #164's dynamic import depends on to fail
 *      soft in an environment without the polyfill package, while a real
 *      break (a syntax error, a broken transitive dependency) still
 *      surfaces loudly instead of resolving a connector to a silent
 *      `undefined`/`null` adapter a caller could mistake for "unsupported
 *      kind".
 *   2. `resolveProviderAuthAdapter`'s consumption of the loaded module is
 *      correct when the module is absent (the swallowed-error case above)
 *      or present but missing the expected export shape — both routes must
 *      resolve to `null`, never throw on a missing property access.
 *   3. Resolution goes through the SAME adapter registry that
 *      `registerProviderAuthAdapter` (imported the plain ESM way, as
 *      real connector/test code does) writes to — the registry-split bug
 *      PR #164 fixed by switching this loader from `require()` to
 *      `import()`. A regression back to a `require()`-loaded copy would
 *      silently miss registrations made via `import` elsewhere; this test
 *      would then see `resolveProviderAuthAdapter` return null for a kind
 *      it just registered.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerProviderAuthAdapter } from "@pdpp/polyfill-connectors/provider-auth-adapter";
import type { ProviderAuthAdapter } from "../server/polyfill-connectors-runtime.ts";
import { moduleNotFoundFallback, resolveProviderAuthAdapter } from "../server/provider-auth-adapter-loader.ts";

test("moduleNotFoundFallback: ERR_MODULE_NOT_FOUND is swallowed to null", () => {
  const error = new Error("Cannot find module") as Error & { code: string };
  error.code = "ERR_MODULE_NOT_FOUND";
  assert.equal(moduleNotFoundFallback(error), null);
});

test("moduleNotFoundFallback: MODULE_NOT_FOUND (the CJS code) is also swallowed to null", () => {
  const error = new Error("Cannot find module") as Error & { code: string };
  error.code = "MODULE_NOT_FOUND";
  assert.equal(moduleNotFoundFallback(error), null);
});

test("moduleNotFoundFallback: an Error with an unrelated code is NOT swallowed — it re-throws", () => {
  const error = new Error("boom") as Error & { code: string };
  error.code = "ERR_SOMETHING_ELSE_ENTIRELY";
  assert.throws(() => moduleNotFoundFallback(error), /boom/);
});

test("moduleNotFoundFallback: an Error with no code at all is NOT swallowed — it re-throws", () => {
  const error = new Error("plain failure, no .code property");
  assert.throws(() => moduleNotFoundFallback(error), /plain failure/);
});

test("moduleNotFoundFallback: a non-Error rejection value is NOT swallowed — it re-throws the value itself", () => {
  assert.throws(() => moduleNotFoundFallback("a rejected string, not an Error"), (thrown: unknown) => thrown === "a rejected string, not an Error");
});

test("moduleNotFoundFallback: a plain object with a matching .code but that is NOT an Error instance is NOT swallowed — the Error check is load-bearing on its own, not redundant with the code check", () => {
  const notAnError = { code: "ERR_MODULE_NOT_FOUND", message: "looks like the right shape, isn't an Error" };
  assert.throws(() => moduleNotFoundFallback(notAnError), (thrown: unknown) => thrown === notAnError);
});

test("resolveProviderAuthAdapter: a real import failure that resolves to null (the package-not-installed case) yields null, not a thrown property-access error", async () => {
  const result = await resolveProviderAuthAdapter("any_kind_whatsoever", () => Promise.resolve(null));
  assert.equal(result, null);
});

test("resolveProviderAuthAdapter: a resolved module missing resolveProviderAuthAdapter entirely yields null", async () => {
  const result = await resolveProviderAuthAdapter("any_kind_whatsoever", () => Promise.resolve({ someUnrelatedExport: true }));
  assert.equal(result, null);
});

test("resolveProviderAuthAdapter: a resolved module whose resolveProviderAuthAdapter is not a function yields null (not a TypeError from calling it)", async () => {
  const result = await resolveProviderAuthAdapter("any_kind_whatsoever", () => Promise.resolve({ resolveProviderAuthAdapter: "not a function" }));
  assert.equal(result, null);
});

test("resolveProviderAuthAdapter: a real rejection from loadModule propagates — it is not swallowed into null", async () => {
  await assert.rejects(
    () =>
      resolveProviderAuthAdapter("any_kind_whatsoever", () => {
        throw new Error("real, unrelated loader failure");
      }),
    /real, unrelated loader failure/
  );
});

test("resolveProviderAuthAdapter: when the resolved module's own resolveProviderAuthAdapter returns an adapter, it is returned verbatim", async () => {
  const fakeAdapter = { marker: "fake-adapter-passthrough-proof" };
  const result = await resolveProviderAuthAdapter("any_kind_whatsoever", () =>
    Promise.resolve({
      resolveProviderAuthAdapter: async (kind: string) => (kind === "any_kind_whatsoever" ? fakeAdapter : null),
    })
  );
  assert.equal(result, fakeAdapter);
});

const REGISTRY_SHARING_TEST_KIND = "provider_auth_adapter_loader_test__registry_sharing_only";

const registrySharingAdapter: ProviderAuthAdapter = {
  exchangeCode: async () => ({ accessToken: "unused", tokenKind: "Bearer" }),
  initiateAuthorization: async () => ({ authorizationUrl: "https://example.test/authorize" }),
  runInventoryOrTest: async () => ({ accounts: [] }),
  storeTokens: async () => ({}),
};

// Registered via the plain ESM `import` path, exactly as a real adapter
// module and generic-provider-auth-dispatch.test.ts's own stub both do —
// never through this loader. If this loader regressed to loading the
// package via `require()` (the bug PR #164 fixed), it would hold its own,
// separate registry Map, and the lookup below would come back null despite
// this registration having already happened.
registerProviderAuthAdapter(REGISTRY_SHARING_TEST_KIND, registrySharingAdapter);

test("resolveProviderAuthAdapter resolves the SAME adapter instance registered via the plain ESM import path (the registry-sharing property PR #164 fixed)", async () => {
  const resolved = await resolveProviderAuthAdapter(REGISTRY_SHARING_TEST_KIND);
  assert.equal(resolved, registrySharingAdapter, "must be the exact registered instance, not a copy or a re-registration under a require()-loaded registry");
});

test("resolveProviderAuthAdapter: an unregistered kind resolves to null rather than throwing", async () => {
  const resolved = await resolveProviderAuthAdapter("provider_auth_adapter_loader_test__never_registered");
  assert.equal(resolved, null);
});

test("resolveProviderAuthAdapter: repeated real resolutions for different kinds all succeed through the one memoized module load (no re-import per call breaks a later lookup)", async () => {
  const first = await resolveProviderAuthAdapter(REGISTRY_SHARING_TEST_KIND);
  const second = await resolveProviderAuthAdapter("provider_auth_adapter_loader_test__never_registered");
  const third = await resolveProviderAuthAdapter(REGISTRY_SHARING_TEST_KIND);
  assert.equal(first, registrySharingAdapter);
  assert.equal(second, null);
  assert.equal(third, registrySharingAdapter, "the same registered instance comes back on a later call through the same memoized load");
});
