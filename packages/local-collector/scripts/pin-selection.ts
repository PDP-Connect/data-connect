// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which catalog release `pin-collection-profiles.ts` pins for each connector.
 *
 * Kept apart from the script so the rules run without the network: a re-run
 * must never move a pin the owner did not ask it to move.
 */

/** A pin that stays where it is, with the reason, read from `collection-profile-holds.json`. */
export interface CollectionProfileHold {
  readonly version: string;
  readonly reason: string;
}

export interface PinArguments {
  /** `--latest`: move connectors that have no hold to the catalog's latest release. */
  readonly latest: boolean;
  /** `--version <connector-key>=<version>`: a named release, which beats a hold. */
  readonly versions: ReadonlyMap<string, string>;
}

export type PinChoice =
  | { readonly kind: "version"; readonly version: string; readonly why: string }
  | { readonly kind: "latest"; readonly why: string };

/**
 * Parse `--latest` and `--version <connector-key>=<version>` (repeatable).
 * Anything else is an error, so a mistyped flag cannot pass for a no-op.
 */
export function parsePinArguments(args: readonly string[], knownKeys: ReadonlySet<string>): PinArguments {
  let latest = false;
  const versions = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--latest") {
      latest = true;
    } else if (arg === "--version") {
      const spec = args[index + 1] ?? "";
      index += 1;
      const parts = spec.split("=");
      const [key, version] = parts;
      if (parts.length !== 2 || !key || !version) {
        throw new Error(`--version takes exactly <connector-key>=<version>, got "${spec}"`);
      }
      if (!knownKeys.has(key)) {
        throw new Error(`--version names unknown connector "${key}"; known: ${[...knownKeys].sort().join(", ")}`);
      }
      if (versions.has(key)) {
        throw new Error(`--version names ${key} twice`);
      }
      versions.set(key, version);
    } else {
      throw new Error(`unknown argument "${arg}"; accepted: --latest, --version <connector-key>=<version>`);
    }
  }
  return { latest, versions };
}

/**
 * Choose a release for one connector, in this order:
 *  1. `--version` names it;
 *  2. a hold keeps it, even under `--latest`;
 *  3. `--latest` takes the catalog's latest;
 *  4. the current pin stays;
 *  5. a connector with no pin yet takes the latest.
 */
export function choosePin(input: {
  readonly connectorKey: string;
  readonly args: PinArguments;
  readonly hold: CollectionProfileHold | undefined;
  readonly currentVersion: string | undefined;
}): PinChoice {
  const requested = input.args.versions.get(input.connectorKey);
  if (requested) {
    return { kind: "version", version: requested, why: "named by --version" };
  }
  if (input.hold) {
    return { kind: "version", version: input.hold.version, why: `held: ${input.hold.reason}` };
  }
  if (input.args.latest) {
    return { kind: "latest", why: "--latest" };
  }
  if (input.currentVersion) {
    return { kind: "version", version: input.currentVersion, why: "current pin kept" };
  }
  return { kind: "latest", why: "no pin yet" };
}

/** Validate the holds file's shape; a malformed hold must not be read as no hold. */
export function parseHolds(raw: unknown): ReadonlyMap<string, CollectionProfileHold> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("collection-profile-holds.json must be an object keyed by connector key");
  }
  const holds = new Map<string, CollectionProfileHold>();
  for (const [key, value] of Object.entries(raw)) {
    const hold = value as Partial<CollectionProfileHold> | null;
    if (!hold || typeof hold.version !== "string" || !hold.version || typeof hold.reason !== "string" || !hold.reason) {
      throw new Error(`hold for "${key}" needs a non-empty version and reason`);
    }
    holds.set(key, { version: hold.version, reason: hold.reason });
  }
  return holds;
}
