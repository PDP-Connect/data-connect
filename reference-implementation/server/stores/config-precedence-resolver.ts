// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one config precedence rule, generalized from the provider-app-config
 * store's DB-first/env-alias-fallback resolver (`createDeploymentConfigResolver`
 * in `provider-app-config-store.ts`) to any config-store-backed key:
 *
 *   An env var is read only when the config store has no value for that key
 *   and the key is not on the platform-owned list; everywhere else, once the
 *   owner has set a value through the UI, that stored value wins even if the
 *   env var is still present, and the env var is consulted again only if the
 *   stored value is cleared.
 *
 * Platform-owned keys (PORT, AS_PORT, RS_PORT today) skip the store
 * entirely -- env always wins for them, and the UI must not be able to fight
 * the platform that injects them. See reference-implementation/README.md,
 * "Config precedence" for the contributor-facing writeup and citations.
 */

export type ConfigPrecedenceGet = (key: string) => Promise<string | null>;

export type ConfigPrecedenceResolver = (args: { envAlias?: string | null; key: string }) => Promise<string | null>;

function normalizeEnvValue(raw: string | undefined): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Builds the generic resolver. `platformOwnedKeys` is matched against the
 * `key` argument (the store's logical key, not the env var name) -- a
 * platform-owned key never reaches the store at all, so the UI has no path
 * to override it even indirectly.
 */
export function createConfigPrecedenceResolver({
  env = process.env,
  getStoredValue,
  platformOwnedKeys = [],
}: {
  env?: NodeJS.ProcessEnv;
  getStoredValue: ConfigPrecedenceGet;
  platformOwnedKeys?: readonly string[];
}): ConfigPrecedenceResolver {
  const platformOwned = new Set(platformOwnedKeys);
  return async ({ key, envAlias }: { envAlias?: string | null; key: string }) => {
    // No envAlias means this key has no env fallback at all -- distinct from
    // an envAlias that happens to be unset in `env`, which still resolves to
    // null via normalizeEnvValue below.
    const readEnv = () => (envAlias ? normalizeEnvValue(env[envAlias]) : null);
    if (platformOwned.has(key)) {
      return readEnv();
    }
    // getStoredValue() returning null means "unset" -- consulting the env
    // var again after a stored value is cleared is exactly this branch, not
    // a separate code path: a cleared key simply resolves through here.
    const fromStore = await getStoredValue(key);
    if (fromStore !== null) {
      return fromStore;
    }
    return readEnv();
  };
}
