// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ReachabilityError } from "./approvals.ts";

export type EarlierSetup = "needs_reentry" | null;
type SavedConfiguration = {
  values?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  uses?: unknown[];
  drafts?: Record<string, unknown>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const configured = (config: SavedConfiguration): boolean =>
  Object.keys(config.values ?? {}).length > 0 || Object.keys(config.bindings ?? {}).length > 0 || (config.uses?.length ?? 0) > 0;

// Configuration scopes include the provider registry identity, which changes
// across SDK releases. Never present a fresh empty scope as the saved setup.
// This reader does not rewrite private bindings or invent new consent.
export async function readEarlierSetup(home: string, currentScopes: string[]): Promise<EarlierSetup> {
  let state: unknown;
  try {
    state = JSON.parse(await readFile(join(home, "embedding-state.json"), "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new ReachabilityError("configuration_migration_required");
  }
  if (!record(state) || state.schemaVersion !== 1 || !record(state.configs)) {
    throw new ReachabilityError("configuration_migration_required");
  }
  const scopes = new Set(currentScopes);
  let earlier = false;
  let current = false;
  for (const [scope, config] of Object.entries(state.configs)) {
    if (!record(config) || [config.values, config.bindings, config.drafts].some(value => value !== undefined && !record(value)) ||
        (config.uses !== undefined && !Array.isArray(config.uses))) {
      throw new ReachabilityError("configuration_migration_required");
    }
    const saved = config as SavedConfiguration;
    if (scopes.has(scope)) current ||= configured(saved);
    else earlier ||= configured(saved) || Object.keys(saved.drafts ?? {}).length > 0;
  }
  return earlier && !current ? "needs_reentry" : null;
}
