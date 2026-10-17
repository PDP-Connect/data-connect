// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Install pinned, signed Collection Profiles and hand their entrypoints to the
 * runner.
 *
 * The transport and the signature check are not implemented here. They are
 * data-connectors' installer core (`@opendatalabs/data-connectors-tools/
 * installer-core`), the same module the reference server installs catalog
 * connectors through: it fetches the OCI manifest by digest, verifies the
 * Sigstore signature against the publish workflow's identity before it reads
 * a layer, checks every blob against its descriptor, and cross-checks config,
 * profile, connector key and version. This module adds three things the
 * collector needs on a user's machine and the installer core does not do:
 *
 *  1. **A reviewed pin.** {@link CollectionProfilePin} records the manifest
 *     digest plus the sha256 of the profile and of the bundled entrypoint. The
 *     pins are compiled into this package, so the package version decides
 *     which connector bytes run, as it did when the connectors were vendored.
 *  2. **A content-addressed cache.** A release lands under
 *     `connectors/<key>/sha256-<digest>/` (see `releaseDirectory`) through a
 *     staging directory and one rename, so an interrupted install never leaves
 *     a half-written release.
 *  3. **An offline check before every run.** A cached release is used only if
 *     its profile and entrypoint still hash to the pinned values. The check
 *     needs no network, so a collector that installed once keeps working
 *     offline, and a modified cache is set aside and installed again.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertContainedEntrypoint, assertRootsDisjoint, type InstalledRelease, releaseDirectory } from "./install-store.ts";

/** Where a Collection Profile artifact puts its runnable module. */
export const COLLECTION_PROFILE_ENTRYPOINT = "dist/collection-profile.mjs";
/** Where a Collection Profile artifact puts its profile JSON. */
export const COLLECTION_PROFILE_MANIFEST = "profile/collection-profile.json";

const PROVENANCE_PATH = "provenance.json";
const REGISTRY = "ghcr.io";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * One pinned Collection Profile release.
 *
 * `digest` is the OCI manifest digest; the signature covers it, and it fixes
 * every layer. The two sha256 values are not a second trust root. They let a
 * run prove, without a network call, that the cached files are the files the
 * signed manifest named.
 */
export interface CollectionProfilePin {
  /** The local collector's id for the connector (`claude_code`). */
  readonly connectorId: string;
  /** The artifact's connector key; also the GHCR repository leaf (`claude-code`). */
  readonly connectorKey: string;
  /** The profile version. The installer core refuses an artifact that declares another. */
  readonly version: string;
  /** OCI manifest digest. */
  readonly digest: string;
  /** sha256 of `profile/collection-profile.json`. */
  readonly profileSha256: string;
  /** sha256 of `dist/collection-profile.mjs`. */
  readonly entrypointSha256: string;
}

/** The part of the installer core this module calls. */
export interface CollectionProfileInstallerCore {
  readonly DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY: string;
  installFromLock(options: Record<string, unknown>): Promise<unknown>;
}

export interface EnsureCollectionProfileOptions {
  readonly pin: CollectionProfilePin;
  /** The install store. Must not contain `durableRoot`, and must not be inside it. */
  readonly installRoot: string;
  /** Where collected data accumulates (the durable outbox directory). */
  readonly durableRoot: string;
  /** Test seam. Defaults to the pinned `@opendatalabs/data-connectors-tools` installer core. */
  readonly loadCore?: () => Promise<CollectionProfileInstallerCore>;
}

/** The GHCR repository a pin names. */
export function collectionProfileRepository(pin: Pick<CollectionProfilePin, "connectorKey">): string {
  return `pdp-connect/connector/${pin.connectorKey}`;
}

/** Where a pinned release lives in the install store. Pure: touches no file. */
export function installedCollectionProfile(installRoot: string, pin: CollectionProfilePin): InstalledRelease {
  const directory = releaseDirectory(installRoot, pin.connectorKey, pin.digest);
  return Object.freeze({
    connectorKey: pin.connectorKey,
    connectorId: pin.connectorId,
    version: pin.version,
    digest: pin.digest,
    directory,
    entrypoint: join(directory, COLLECTION_PROFILE_ENTRYPOINT),
  });
}

/**
 * Why a release directory does not hold the pinned files, or `null` when it
 * does. Reads only local files.
 */
export function collectionProfileMismatch(directory: string, pin: CollectionProfilePin): string | null {
  const entrypoint = assertContainedEntrypoint(directory, COLLECTION_PROFILE_ENTRYPOINT);
  const profile = assertContainedEntrypoint(directory, COLLECTION_PROFILE_MANIFEST);
  for (const [label, path, expected] of [
    ["profile", profile, pin.profileSha256],
    ["entrypoint", entrypoint, pin.entrypointSha256],
  ] as const) {
    if (!existsSync(path)) {
      return `${label} ${path} is missing`;
    }
    const actual = sha256File(path);
    if (actual !== expected) {
      return `${label} ${path} hashes to ${actual}, the pin says ${expected}`;
    }
  }
  return null;
}

/**
 * Return the installed release for a pin, installing it first if the cache
 * does not hold exactly the pinned files.
 *
 * Install is all or nothing: the installer core verifies and writes into a
 * fresh staging directory, the staged files are checked against the pin, and
 * only then is the release renamed into place. Any failure leaves the store as
 * it was, apart from a cached release that failed its check, which is renamed
 * aside (never deleted) so it can be inspected.
 */
export async function ensureCollectionProfileInstalled(
  options: EnsureCollectionProfileOptions
): Promise<InstalledRelease> {
  const { pin, installRoot, durableRoot } = options;
  assertPin(pin);
  assertRootsDisjoint(installRoot, durableRoot);

  const release = installedCollectionProfile(installRoot, pin);
  if (existsSync(release.directory)) {
    const mismatch = collectionProfileMismatch(release.directory, pin);
    if (mismatch === null) {
      return release;
    }
    const aside = `${release.directory}.invalid-${randomBytes(8).toString("hex")}`;
    renameSync(release.directory, aside);
    process.emitWarning(
      `Cached ${pin.connectorId} Collection Profile did not match its pin (${mismatch}); moved it to ${aside} and installing again.`,
      "CollectionProfileCacheWarning"
    );
  }

  mkdirSync(dirname(release.directory), { recursive: true });
  const staging = `${release.directory}.staging-${randomBytes(16).toString("hex")}`;
  // Not recursive: an existing path is refused rather than adopted.
  mkdirSync(staging);
  try {
    const core = await (options.loadCore ?? loadInstallerCore)();
    const repository = collectionProfileRepository(pin);
    const identityResolver = ({ registry, repository: requested }: { registry: string; repository: string }) =>
      registry === REGISTRY && requested === repository ? core.DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY : null;
    await core.installFromLock({
      // Tarball entries are not accepted from this lock.
      artifactCertificateIdentityResolver: () => null,
      installRoot: staging,
      layout: "source",
      lock: {
        lockVersion: "2.0",
        connectors: [
          {
            artifactKind: "pdpp-collection-profile",
            connectorId: pin.connectorId,
            connectorKey: pin.connectorKey,
            entrypointPath: COLLECTION_PROFILE_ENTRYPOINT,
            manifestPath: COLLECTION_PROFILE_MANIFEST,
            oci: { digest: pin.digest, registry: REGISTRY, repository },
            provenancePath: PROVENANCE_PATH,
            version: pin.version,
          },
        ],
      },
      ociCertificateIdentityResolver: identityResolver,
      source: { doc: {}, mode: "locked" },
    });

    const staged = join(staging, "collection-profiles", pin.connectorId);
    const mismatch = collectionProfileMismatch(staged, pin);
    if (mismatch !== null) {
      throw new Error(`verified ${pin.connectorId} artifact ${pin.digest} does not match its pin: ${mismatch}`);
    }
    try {
      renameSync(staged, release.directory);
    } catch (error) {
      // Another collector finished the same install first. Its copy is
      // acceptable only if it passes the same check.
      if (!existsSync(release.directory) || collectionProfileMismatch(release.directory, pin) !== null) {
        throw error;
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return release;
}

async function loadInstallerCore(): Promise<CollectionProfileInstallerCore> {
  return (await import("@opendatalabs/data-connectors-tools/installer-core")) as CollectionProfileInstallerCore;
}

function assertPin(pin: CollectionProfilePin): void {
  for (const [label, value] of [
    ["digest", pin.digest],
    ["profileSha256", pin.profileSha256],
    ["entrypointSha256", pin.entrypointSha256],
  ] as const) {
    if (!DIGEST.test(value)) {
      throw new Error(`${pin.connectorId} pin has an invalid ${label}: ${JSON.stringify(value)}`);
    }
  }
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
