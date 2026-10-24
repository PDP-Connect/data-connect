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
import { existsSync, readFileSync } from "node:fs";

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

const releaseOverrides = new Map<string, LocalCollectorRelease>();

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
 * collector does not install that connector. Throws when the pinned file is
 * missing or does not hash to its pin.
 */
export function readLocalCollectorProfile(connectorKey: string): Record<string, unknown> | null {
  return readPinnedProfile(connectorKey)?.profile ?? null;
}

/** The server's current OCI artifact identity for a local-device connector. */
export function readLocalCollectorArtifactDigest(connectorKey: string): string | null {
  const override = releaseOverrides.get(connectorKey);
  if (override) {
    return override.artifactDigest;
  }
  try {
    return readPinnedProfile(connectorKey)?.digest ?? null;
  } catch {
    // A missing or invalid pin cannot establish executable identity.
    return null;
  }
}

/** The installed execution release as one atomically read, pin-verified pair. */
export function readLocalCollectorRelease(connectorKey: string): LocalCollectorRelease | null {
  const override = releaseOverrides.get(connectorKey);
  if (override) {
    return override;
  }
  try {
    const pinned = readPinnedProfile(connectorKey);
    return pinned ? { artifactDigest: pinned.digest, manifest: pinned.profile } : null;
  } catch {
    // A missing or invalid pair cannot establish which release was executed.
    return null;
  }
}

function readPinnedProfile(connectorKey: string): { digest: string; profile: Record<string, unknown> } | null {
  if (!CONNECTOR_KEY.test(connectorKey)) {
    return null;
  }
  const pinUrl = new URL(`./local-collector-profiles/${connectorKey}.pin.json`, import.meta.url);
  if (!existsSync(pinUrl)) {
    return null;
  }
  const pin = JSON.parse(readFileSync(pinUrl, "utf8")) as LocalCollectorProfilePin;
  const bytes = readFileSync(new URL(`./local-collector-profiles/${connectorKey}.json`, import.meta.url));
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (pin.connector_key !== connectorKey || !ARTIFACT_DIGEST.test(pin.digest) || actual !== pin.profile_sha256) {
    throw new Error(
      `local collector profile ${connectorKey}.json hashes to ${actual}, but its pin (${pin.digest}) says ${pin.profile_sha256}`
    );
  }
  return { digest: pin.digest, profile: JSON.parse(bytes.toString("utf8")) as Record<string, unknown> };
}
