// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Collection Profiles that `@pdpp/local-collector` installs, as the
 * reference server sees them.
 *
 * A local collector runs its connectors on the owner's device, so the
 * manifest the server registers at enrollment must be the profile of the
 * release the device runs, not a catalog install on this server. The
 * collector pins each release by OCI digest; `local-collector-profiles/`
 * holds the verbatim profile JSON of every pin (`<key>.json`) and a pin
 * record with its sha256 (`<key>.pin.json`). Both are written by
 * `packages/local-collector/scripts/pin-collection-profiles.ts` from
 * signature-verified artifacts, and a collector test fails if they disagree
 * with the collector's own pins.
 *
 * This lives inside `reference-implementation/` because the desktop release
 * stages only this directory (see scripts/ensure-reference-stack.js).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalConnectorKey } from "./connector-key.ts";

interface LocalCollectorProfilePin {
  readonly connector_key: string;
  readonly digest: string;
  readonly profile_sha256: string;
  readonly version: string;
}

export interface LocalCollectorRelease {
  readonly artifactDigest: string;
  readonly manifest: Record<string, unknown>;
}

const CONNECTOR_KEY = /^[a-z0-9][a-z0-9-]*$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROFILE_SHA256 = /^sha256:[a-f0-9]{64}$/;

export type PinnedLocalCollectorManifestResult =
  | { readonly kind: "not_local" }
  | { readonly kind: "verified"; readonly manifest: Record<string, unknown> }
  | {
      readonly kind: "invalid_pin";
      readonly reason: string;
      readonly reasonCategory: PinnedProfileFailureCategory;
      readonly expectedDigest: string | null;
      readonly observedDigest: string | null;
    };

export type PinnedProfileFailureCategory =
  | "pin_unreadable"
  | "pin_unparseable"
  | "pin_inconsistent"
  | "profile_missing"
  | "profile_unreadable"
  | "profile_digest_mismatch"
  | "profile_unparseable";

const releaseOverrides = new Map<string, LocalCollectorRelease>();
let localCollectorProfilesDirectoryForTest: string | null = null;

/** Test seam: read real pin records from a temporary directory instead of shipped data. */
export function __setLocalCollectorProfilesDirectoryForTest(directory: string | null): void {
  localCollectorProfilesDirectoryForTest = directory;
}

/**
 * Test seam: serve `release` for `connectorKey` in place of its checked-in pin,
 * or restore the pin when `release` is null. Production never calls it. The
 * checked-in pins are the signed releases, so a test needs this to register a
 * release that declares terminal coverage before any such pin exists.
 */
export function __setLocalCollectorReleaseForTest(connectorKey: string, release: LocalCollectorRelease | null): void {
  if (release) {
    releaseOverrides.set(connectorKey, release);
  } else {
    releaseOverrides.delete(connectorKey);
  }
}

/**
 * The pinned profile for a canonical connector key, or `null` when the local
 * collector does not install that connector. Throws when a present pin or its
 * profile is unreadable, invalid, or inconsistent.
 */
export function readLocalCollectorProfile(connectorKey: string): Record<string, unknown> | null {
  const result = readPinnedProfile(connectorKey);
  if (result.kind === "invalid_pin") {
    throw new Error(result.reason);
  }
  return result.kind === "verified" ? result.profile : null;
}

/**
 * The manifest the server registers for a connector the local collector runs
 * on the owner's device: the pinned profile under its canonical key, or
 * `null` for any other connector. Enrollment, catalog installs and the boot
 * reconcile all register this one manifest, so none of them can replace it
 * with a catalog release the device does not run.
 */
export function pinnedLocalCollectorManifest(connectorId: string): Record<string, unknown> | null {
  const result = readPinnedLocalCollectorManifest(connectorId);
  if (result.kind === "invalid_pin") throw new Error(result.reason);
  return result.kind === "verified" ? result.manifest : null;
}

/** Resolve pin state from the same record and profile read used by other callers. */
export function readPinnedLocalCollectorManifest(connectorId: string): PinnedLocalCollectorManifestResult {
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const result = readPinnedProfile(connectorKey);
  if (result.kind !== "verified") {
    return result;
  }
  return {
    kind: "verified",
    manifest: {
      ...result.profile,
      connector_id: connectorKey,
      display_name: result.profile.display_name || connectorKey,
    },
  };
}

/** The server's current OCI artifact identity for a local-device connector. */
export function readLocalCollectorArtifactDigest(connectorKey: string): string | null {
  const override = releaseOverrides.get(connectorKey);
  if (override) {
    return override.artifactDigest;
  }
  const result = readPinnedProfile(connectorKey);
  return result.kind === "verified" ? result.digest : null;
}

/** The installed execution release as one atomically read, pin-verified pair. */
export function readLocalCollectorRelease(connectorKey: string): LocalCollectorRelease | null {
  const override = releaseOverrides.get(connectorKey);
  if (override) {
    return override;
  }
  const result = readPinnedProfile(connectorKey);
  return result.kind === "verified" ? { artifactDigest: result.digest, manifest: result.profile } : null;
}

type PinnedProfileResult =
  | { readonly kind: "not_local" }
  | { readonly kind: "verified"; readonly digest: string; readonly profile: Record<string, unknown> }
  | {
      readonly kind: "invalid_pin";
      readonly reason: string;
      readonly reasonCategory: PinnedProfileFailureCategory;
      readonly expectedDigest: string | null;
      readonly observedDigest: string | null;
    };

function readPinnedProfile(connectorKey: string): PinnedProfileResult {
  if (!CONNECTOR_KEY.test(connectorKey)) {
    return { kind: "not_local" };
  }
  let pinBytes: Buffer;
  try {
    pinBytes = readLocalCollectorProfileFile(connectorKey, ".pin.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "not_local" };
    }
    return invalidPin("pin_unreadable");
  }
  let pin: LocalCollectorProfilePin;
  try {
    pin = JSON.parse(pinBytes.toString("utf8")) as LocalCollectorProfilePin;
  } catch {
    return invalidPin("pin_unparseable");
  }
  if (
    !pin ||
    typeof pin !== "object" ||
    pin.connector_key !== connectorKey ||
    !ARTIFACT_DIGEST.test(pin.digest) ||
    !PROFILE_SHA256.test(pin.profile_sha256) ||
    typeof pin.version !== "string"
  ) {
    return invalidPin("pin_inconsistent");
  }
  let bytes: Buffer;
  try {
    bytes = readLocalCollectorProfileFile(connectorKey, ".json");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return invalidPin(
      missing ? "profile_missing" : "profile_unreadable",
      missing
        ? "The installed local connector profile is missing and could not be verified. Reinstall the local collector to repair it."
        : undefined,
      pin.profile_sha256
    );
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== pin.profile_sha256) {
    return invalidPin("profile_digest_mismatch", undefined, pin.profile_sha256, actual);
  }
  let profile: unknown;
  try {
    profile = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalidPin("profile_unparseable", undefined, pin.profile_sha256, actual);
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return invalidPin("profile_unparseable", undefined, pin.profile_sha256, actual);
  }
  return { kind: "verified", digest: pin.digest, profile: profile as Record<string, unknown> };
}

function readLocalCollectorProfileFile(connectorKey: string, suffix: ".json" | ".pin.json"): Buffer {
  if (localCollectorProfilesDirectoryForTest) {
    return readFileSync(join(localCollectorProfilesDirectoryForTest, `${connectorKey}${suffix}`));
  }
  return readFileSync(new URL(`./local-collector-profiles/${connectorKey}${suffix}`, import.meta.url));
}

function invalidPin(
  reasonCategory: PinnedProfileFailureCategory,
  reason = "The installed local connector profile failed verification. Reinstall the local collector to repair it.",
  expectedDigest: string | null = null,
  observedDigest: string | null = null
): PinnedProfileResult {
  return { kind: "invalid_pin", reason, reasonCategory, expectedDigest, observedDigest };
}
