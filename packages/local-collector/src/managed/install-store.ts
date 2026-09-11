// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The content-addressed install store: where verified connector releases land.
 *
 * Two roots exist on a host and they must never contain one another:
 *
 *  - the **install store** (here): immutable, manager-owned, keyed by digest.
 *    Every release is written once under `sha256-<digest>/` and never edited.
 *    An upgrade writes a new sibling; a rollback repoints a pointer.
 *  - the **durable artifact root**: mutable, deployment-owned, where a
 *    connector accumulates collected data. Slack's multi-GB `slackdump.sqlite`
 *    lives there.
 *
 * The decision's constraint is "upgrading or removing installed code must
 * never delete a collected archive", and the reason it is a hard constraint
 * rather than a nicety is recorded in the tree: when Slack's archive once
 * lived outside the mounted volume, "nine consecutive real runs died on
 * slackdump_timeout after re-accumulating ~138-198MB apiece".
 *
 * {@link assertRootsDisjoint} makes that structural rather than careful.
 * Uninstall removes a whole connector directory under the install store and
 * touches nothing else; the archive survives because the two trees are proven
 * disjoint at startup, not because uninstall maintains an exclusion list. An
 * exclusion list is a thing that can be wrong once; disjointness is a thing
 * that is checked every run.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { LAYER_MEDIA_TYPES } from "./artifact-contract.ts";
import type { VerifiedArtifact } from "./registry-client.ts";

/**
 * Prove the install store and the durable artifact root cannot reach each
 * other, comparing realpaths so a symlink cannot smuggle one inside the other.
 *
 * Comparing the strings a caller passed in would miss exactly the case worth
 * catching: an install store that is a symlink into the durable tree looks
 * disjoint by path and is not disjoint on disk. Symlinks are therefore
 * resolved on whatever part of each path already exists, and the not-yet-
 * created remainder is re-appended — either root may legitimately be absent on
 * a first run, and collapsing an absent root onto its nearest existing
 * ancestor would report two siblings as nested.
 */
export function assertRootsDisjoint(installRoot: string, durableRoot: string): void {
  const real = (candidate: string): string => {
    // Resolve symlinks on the part of the path that exists, then re-append the
    // part that does not. Resolving only the existing ancestor would collapse
    // two not-yet-created siblings onto their shared parent and report them as
    // nested — which is the common case on a first run, when neither root has
    // been created yet.
    const absolute = resolve(candidate);
    let existing = absolute;
    const pending: string[] = [];
    while (!existsSync(existing) && dirname(existing) !== existing) {
      pending.unshift(basename(existing));
      existing = dirname(existing);
    }
    return pending.length === 0 ? realpathSync(existing) : join(realpathSync(existing), ...pending);
  };

  const install = real(installRoot);
  const durable = real(durableRoot);

  // `relative()` answers "how do I get from parent to child": a path that
  // needs no `..` to climb out, and is not itself absolute, is a path that
  // stays inside. Checking `isAbsolute` matters on Windows, where `relative()`
  // returns an absolute path when the two roots are on different drives —
  // different drives being the one case that is genuinely disjoint.
  const contains = (parent: string, child: string): boolean => {
    if (parent === child) return true;
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  };

  if (contains(install, durable) || contains(durable, install)) {
    throw new Error(
      `connector install store (${install}) and durable artifact root (${durable}) must not contain one another: ` +
        `an upgrade or uninstall under the install store would delete collected data`
    );
  }
}

/** Filesystem-safe rendering of a digest: `sha256:ab…` becomes `sha256-ab…`. */
export function digestDirectoryName(digest: string): string {
  return digest.replace(":", "-");
}

/** Where one release's bytes live. */
export function releaseDirectory(installRoot: string, connectorKey: string, digest: string): string {
  return join(installRoot, "connectors", connectorKey, digestDirectoryName(digest));
}

/**
 * One member of an unpacked layer, after the safety filter has passed it.
 */
interface TarMember {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Reject an archive member that could write outside the release directory or
 * that is not a plain file.
 *
 * These rules are carried over from the incumbent installer rather than
 * reinvented, because they are the hard-won part of it: absolute paths, `..`
 * segments, backslashes and NUL bytes are all path-escape primitives, and
 * symlinks, hardlinks and FIFOs are how an archive escapes a containment check
 * that only looked at member *names*. A connector artifact has no legitimate
 * use for any of them — its code layer is a single bundled `.mjs` plus data
 * files — so the filter costs nothing and closes the whole class.
 */
export function assertSafeMemberPath(path: string, typeflag: string): void {
  if (path.length === 0) {
    throw new Error("archive member has an empty path");
  }
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`archive member has an absolute path: ${JSON.stringify(path)}`);
  }
  if (path.includes("\\")) {
    throw new Error(`archive member path contains a backslash: ${JSON.stringify(path)}`);
  }
  if (path.includes("\0")) {
    throw new Error(`archive member path contains a NUL byte: ${JSON.stringify(path)}`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`archive member path escapes the archive root: ${JSON.stringify(path)}`);
  }
  // tar typeflag: '0'/'\0' regular file, '5' directory. Everything else —
  // symlink ('2'), hardlink ('1'), char/block device ('3'/'4'), FIFO ('6') —
  // is refused rather than skipped, so a malicious member cannot be quietly
  // dropped and reported as a successful install.
  if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
    throw new Error(`archive member ${JSON.stringify(path)} is not a regular file (typeflag ${JSON.stringify(typeflag)})`);
  }
}

/**
 * Minimal POSIX tar reader for the gzipped layers.
 *
 * Written here rather than taken from a dependency for one reason: the safety
 * filter has to run *during* extraction, on every member, before any byte
 * reaches the filesystem. A library that extracts to a directory and lets you
 * inspect afterwards has already written the symlink by the time you look.
 * Layers are small (a bundled connector is hundreds of KB), so a
 * straightforward in-memory reader is the right size of tool.
 */
export function readTarGz(gzipped: Uint8Array): readonly TarMember[] {
  const buffer = gunzipSync(gzipped);
  const members: TarMember[] = [];
  let offset = 0;

  while (offset + 512 <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every((byte) => byte === 0)) break;

    const readField = (start: number, length: number): string =>
      Buffer.from(header.subarray(start, start + length))
        .toString("utf8")
        .replace(/\0.*$/, "")
        .trim();

    const name = readField(0, 100);
    const prefix = readField(345, 155);
    const sizeField = readField(124, 12);
    const typeflag = Buffer.from(header.subarray(156, 157)).toString("utf8");
    const size = Number.parseInt(sizeField === "" ? "0" : sizeField, 8);

    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`archive member ${JSON.stringify(name)} declares an unreadable size`);
    }

    const path = prefix === "" ? name : `${prefix}/${name}`;
    // Skip tar's own metadata entries rather than treating them as content.
    const isPaxOrLongName = typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K";
    if (!isPaxOrLongName) {
      assertSafeMemberPath(path, typeflag);
      if (typeflag !== "5") {
        members.push({ path, bytes: buffer.subarray(offset + 512, offset + 512 + size) });
      }
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return members;
}

/** A release on disk, after install. */
export interface InstalledRelease {
  readonly connectorKey: string;
  readonly connectorId: string;
  readonly version: string;
  readonly digest: string;
  readonly directory: string;
  /** Absolute path of the connector's entrypoint module. */
  readonly entrypoint: string;
}

/**
 * Write a verified artifact into the install store.
 *
 * Installing never activates. The bytes land under their digest and that is
 * all — the decision's constraint is that updates are "staged and activated
 * between runs, never mid-collection", and the way to honour that is for the
 * fetching half to have no power to change what runs. Activation is a separate
 * pointer move (see {@link activateRelease}).
 *
 * Writes go to a staging directory first and are renamed into place, so an
 * interrupted install leaves a staging directory and no half-written release
 * that a later run might mistake for a complete one.
 */
export function installVerifiedArtifact(input: {
  readonly artifact: VerifiedArtifact;
  readonly installRoot: string;
  readonly durableRoot: string;
}): InstalledRelease {
  const { artifact, installRoot, durableRoot } = input;
  assertRootsDisjoint(installRoot, durableRoot);

  const { config, pinned, layers } = artifact;
  const target = releaseDirectory(installRoot, config.connector_key, pinned.digest);

  if (existsSync(target)) {
    // Already installed. The directory is named by digest and its contents are
    // immutable, so re-installing the same digest is a no-op rather than a
    // rewrite — which is what makes install idempotent and safe to run during
    // a collection.
    return describeRelease(target, config, pinned);
  }

  const staging = `${target}.staging-${createHash("sha256").update(`${process.pid}:${Date.now()}`).digest("hex").slice(0, 12)}`;
  mkdirSync(staging, { recursive: true });

  try {
    const writeFile = (relativePath: string, bytes: Uint8Array): void => {
      const destination = join(staging, relativePath);
      // Defence in depth: the member path was filtered during extraction, and
      // the resolved destination is checked again here. The two checks fail
      // for different reasons (a bad member name vs. a bad join), and the
      // cost of keeping both is one comparison.
      const relativeToStaging = relative(staging, destination);
      if (relativeToStaging.startsWith("..") || relativeToStaging === "") {
        throw new Error(`refusing to write outside the release directory: ${JSON.stringify(relativePath)}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    };

    // JSON layers land as files so the installed release is self-describing:
    // a host can answer "what is this and where did it come from" from the
    // directory alone, without the registry.
    const profileBytes = layers.get(LAYER_MEDIA_TYPES.profile);
    if (profileBytes !== undefined) writeFile("collection-profile.json", profileBytes);
    const provenanceBytes = layers.get(LAYER_MEDIA_TYPES.provenance);
    if (provenanceBytes !== undefined) writeFile("provenance.json", provenanceBytes);
    writeFile("config.json", new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`));
    writeFile(
      "oci-manifest.json",
      new TextEncoder().encode(`${JSON.stringify(artifact.manifest, null, 2)}\n`)
    );

    for (const [mediaType, prefix] of [
      [LAYER_MEDIA_TYPES.code, "code"],
      [LAYER_MEDIA_TYPES.assets, "assets"],
      [LAYER_MEDIA_TYPES.licenses, "licenses"],
    ] as const) {
      const blob = layers.get(mediaType);
      if (blob === undefined) continue;
      for (const member of readTarGz(blob)) {
        writeFile(join(prefix, member.path), member.bytes);
      }
    }

    const entrypoint = join(staging, config.entrypoint);
    if (!existsSync(entrypoint)) {
      throw new Error(
        `artifact declares entrypoint ${JSON.stringify(config.entrypoint)} but it is absent after unpack`
      );
    }

    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return describeRelease(target, config, pinned);
}

function describeRelease(
  directory: string,
  config: VerifiedArtifact["config"],
  pinned: VerifiedArtifact["pinned"]
): InstalledRelease {
  return Object.freeze({
    connectorKey: config.connector_key,
    connectorId: config.connector_id,
    version: config.version,
    digest: pinned.digest,
    directory,
    entrypoint: join(directory, config.entrypoint),
  });
}

/**
 * Point `current` at an installed release.
 *
 * Written as a `current.json` pointer file rather than a symlink. A symlink is
 * the more idiomatic POSIX answer and is atomic via rename, but it needs
 * privilege on Windows, and this runner ships to desktops. The *semantics* are
 * the pointer swap either way; a JSON file keeps one implementation across
 * platforms rather than two that can diverge.
 *
 * Activation is separated from install so that a collection in progress keeps
 * running the release it started with: the running process already resolved an
 * absolute path under a digest directory whose contents never change.
 */
export function activateRelease(installRoot: string, release: InstalledRelease): void {
  const pointerPath = join(installRoot, "connectors", release.connectorKey, "current.json");
  mkdirSync(dirname(pointerPath), { recursive: true });
  const temporary = `${pointerPath}.tmp-${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ digest: release.digest, version: release.version, activatedAt: new Date().toISOString() }, null, 2)}\n`
  );
  renameSync(temporary, pointerPath);
}
