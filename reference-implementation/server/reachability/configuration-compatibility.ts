// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReachabilityError } from "./approvals.ts";

// Configuration scopes include the provider registry identity, which changes
// across SDK releases. Never present a fresh empty scope as the saved setup.
// This reader does not rewrite private bindings or invent new consent.
export async function requireCompatibleConfiguration(home: string, currentScopes: string[]): Promise<void> {
  let state: { schemaVersion: number; configs: Record<string, { values?: Record<string, unknown>; bindings?: Record<string, unknown>; uses?: unknown[] }> };
  try {
    state = JSON.parse(await readFile(join(home, "embedding-state.json"), "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw new ReachabilityError("configuration_migration_required");
  }
  if (state.schemaVersion !== 1 || !state.configs || typeof state.configs !== "object") {
    throw new ReachabilityError("configuration_migration_required");
  }
  const scopes = new Set(currentScopes);
  for (const [scope, config] of Object.entries(state.configs)) {
    if (!scopes.has(scope) && (Object.keys(config.values ?? {}).length || Object.keys(config.bindings ?? {}).length || config.uses?.length)) {
      throw new ReachabilityError("configuration_migration_required");
    }
  }
}
