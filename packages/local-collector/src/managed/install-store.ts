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

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  // Resolve symlinks on the part of each path that exists, then re-append the
  // part that does not. Resolving only the existing ancestor would collapse
  // two not-yet-created siblings onto their shared parent and report them as
  // nested — which is the common case on a first run, when neither root has
  // been created yet.
  const install = realpathOfExistingPrefix(installRoot);
  const durable = realpathOfExistingPrefix(durableRoot);

  if (containsPath(install, durable) || containsPath(durable, install)) {
    throw new Error(
      `connector install store (${install}) and durable artifact root (${durable}) must not contain one another: ` +
        `an upgrade or uninstall under the install store would delete collected data`
    );
  }
}

/**
 * Answer "does `parent` contain `child`" the way `assertRootsDisjoint` does.
 *
 * `relative()` answers "how do I get from parent to child": a path that needs
 * no `..` to climb out, and is not itself absolute, is a path that stays
 * inside. `isAbsolute` matters on Windows, where `relative()` returns an
 * absolute path across drives.
 */
function containsPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Resolve symlinks on the part of a path that exists and re-append the part
 * that does not, so a not-yet-created path is not collapsed onto its nearest
 * existing ancestor.
 */
function realpathOfExistingPrefix(candidate: string): string {
  const absolute = resolve(candidate);
  let existing = absolute;
  const pending: string[] = [];
  while (!pathPresent(existing) && dirname(existing) !== existing) {
    pending.unshift(basename(existing));
    existing = dirname(existing);
  }
  // `realpathSync` needs a resolvable path. A component that is present but
  // dangling (a symlink whose target does not exist yet) is not resolvable, so
  // follow the link by hand and re-append the remainder — the point is to learn
  // where the component *points*, not to require that it already works.
  //
  // `resolve`, not `join`: a symlink target may be absolute, and `join` would
  // splice an absolute target onto the link's parent to produce a path that is
  // neither real nor outside the store, which is how a redirected component
  // would slip past the containment check below.
  try {
    return pending.length === 0 ? realpathSync(existing) : join(realpathSync(existing), ...pending);
  } catch {
    const viaLink = resolve(dirname(existing), readlinkSync(existing));
    return pending.length === 0 ? viaLink : join(viaLink, ...pending);
  }
}

/**
 * "Is there something here", as distinct from "does something resolvable live
 * here".
 *
 * `existsSync` follows symlinks, so it answers `false` for a dangling one and
 * a caller walking up a path would step straight past it — treating a
 * redirected component as a plain not-yet-created directory and losing exactly
 * the redirection worth catching. `lstat` answers the question actually being
 * asked: is this component present at all.
 */
function pathPresent(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path that must live inside the install store, refusing it if any
 * component of it is redirected out of the store.
 *
 * {@link assertRootsDisjoint} proves the two *roots* are disjoint. That is not
 * enough on its own: it says nothing about the descendants the installer walks
 * afterwards. A pre-existing `install/connectors/<key> → durable-data` symlink
 * leaves both roots exactly where they were declared, and still causes a fresh
 * install to write its staging directory and its final release inside the
 * durable tree. The separation the module's header promises — "upgrading or
 * removing installed code must never delete a collected archive" — is then
 * false, because the code *is* the archive directory.
 *
 * So the fixed boundary is the **canonical install root**, resolved once, and
 * every store path is canonicalized and checked back against it. A redirected
 * descendant is refused rather than treated as a new valid root, which is the
 * distinction {@link assertContainedEntrypoint} alone cannot make: it
 * canonicalizes the release directory it is handed, so a release directory that
 * has *already* been redirected simply becomes the root it validates against.
 *
 * What this does not cover, stated plainly rather than implied:
 *
 *  - **Ownership.** This checks where a path resolves, not who may write there.
 *    A store on a world-writable path is still a store anyone can rewrite; that
 *    is a deployment property (directory permissions, a dedicated user), not
 *    something a path check can establish.
 *  - **Concurrent replacement.** This is a precheck, so it is TOCTOU-bounded:
 *    an attacker who can swap a component between this check and the subsequent
 *    write can still win the race. Closing that needs `O_NOFOLLOW`-class
 *    handle-relative operations, which Node's `fs` does not expose portably.
 *    The check therefore raises the bar from "a symlink planted at any time
 *    silently redirects the store" to "an attacker must already have write
 *    access to the store *and* win a race", and is not claimed to do more.
 */
function resolveInsideStore(canonicalInstallRoot: string, candidate: string, what: string): string {
  const resolved = realpathOfExistingPrefix(candidate);
  if (!containsPath(canonicalInstallRoot, resolved) || resolved === canonicalInstallRoot) {
    throw new Error(
      `${what} ${JSON.stringify(candidate)} resolves to ${resolved}, outside the connector install store ${canonicalInstallRoot}: ` +
        `refusing to treat a redirected store path as a valid release location`
    );
  }
  return resolved;
}

/**
 * The canonical install root, which is the trust boundary every store path is
 * measured against. Resolved once per operation so a single consistent answer
 * is used for every check within it.
 */
function canonicalStoreRoot(installRoot: string): string {
  return realpathOfExistingPrefix(installRoot);
}

/**
 * Reject a `config.entrypoint` that does not name a file inside the release.
 *
 * The install store's whole claim is that a release's bytes are contained
 * under one digest-named directory, and `entrypoint` is the one field that is
 * joined onto that directory without ever passing the archive member filter.
 * An entrypoint of `../../../../elsewhere/evil.mjs` is not a member path, so
 * {@link assertSafeMemberPath} never sees it; unchecked, it makes the release's
 * declared entrypoint a path the host never verified and never unpacked. The
 * runner spawns that path, so the field decides what code runs.
 *
 * The string rules come first and are the same class the publisher applies to
 * connector names before they reach a shell: absolute paths, `..` segments,
 * backslashes and NUL bytes are path-escape primitives with no legitimate use
 * in a bundled connector's entrypoint. But string rules alone are not enough,
 * because a path that is textually contained can still resolve outside through
 * a symlink. So the resolved entrypoint is compared against the release root by
 * **realpath**, not by string prefix — the same reason
 * {@link assertRootsDisjoint} compares realpaths rather than the strings a
 * caller passed in.
 */
export function assertContainedEntrypoint(releaseRoot: string, entrypoint: string): string {
  if (entrypoint.length === 0) {
    throw new Error("artifact declares an empty entrypoint");
  }
  if (isAbsolute(entrypoint) || entrypoint.startsWith("/") || /^[a-zA-Z]:/.test(entrypoint)) {
    throw new Error(`artifact declares an absolute entrypoint: ${JSON.stringify(entrypoint)}`);
  }
  if (entrypoint.includes("\\")) {
    throw new Error(`artifact entrypoint contains a backslash: ${JSON.stringify(entrypoint)}`);
  }
  if (entrypoint.includes("\0")) {
    throw new Error(`artifact entrypoint contains a NUL byte: ${JSON.stringify(entrypoint)}`);
  }
  if (entrypoint.split("/").includes("..")) {
    throw new Error(`artifact entrypoint escapes the release directory: ${JSON.stringify(entrypoint)}`);
  }

  const resolved = join(releaseRoot, entrypoint);
  const realRoot = realpathOfExistingPrefix(releaseRoot);
  const realEntrypoint = realpathOfExistingPrefix(resolved);
  if (realRoot === realEntrypoint || !containsPath(realRoot, realEntrypoint)) {
    throw new Error(
      `artifact entrypoint ${JSON.stringify(entrypoint)} resolves to ${realEntrypoint}, outside the release directory ${realRoot}`
    );
  }
  return resolved;
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

  // The fixed trust boundary for every path below, resolved once.
  const storeRoot = canonicalStoreRoot(installRoot);

  const { config, pinned, layers } = artifact;
  const target = releaseDirectory(installRoot, config.connector_key, pinned.digest);
  // The release's parent (`connectors/<key>`) is checked as well as the release
  // itself: redirecting the parent is what relocates a *fresh* install, and the
  // release path does not exist yet at that point to be checked on its own.
  resolveInsideStore(storeRoot, dirname(target), "connector directory");
  const canonicalTarget = resolveInsideStore(storeRoot, target, "release directory");

  if (existsSync(target)) {
    // Already installed — but a digest in a directory name is not evidence that
    // the current contents still match it. The cached release is only reusable
    // if it still agrees with the authenticated layers we are holding; anything
    // else is quarantined and rebuilt from those layers below.
    const reusable = cachedReleaseMatches(canonicalTarget, artifact);
    if (reusable === null) {
      return describeRelease(canonicalTarget, config, pinned, storeRoot);
    }
    quarantineRelease(canonicalTarget, storeRoot, reusable);
  }

  const staging = `${target}.staging-${createHash("sha256").update(`${process.pid}:${Date.now()}`).digest("hex").slice(0, 12)}`;
  mkdirSync(staging, { recursive: true });
  const canonicalStaging = resolveInsideStore(storeRoot, staging, "staging directory");

  try {
    const writeFile = (relativePath: string, bytes: Uint8Array): void => {
      const destination = join(canonicalStaging, relativePath);
      // Defence in depth: the member path was filtered during extraction, and
      // the resolved destination is checked again here. The two checks fail
      // for different reasons (a bad member name vs. a bad join), and the
      // cost of keeping both is one comparison.
      const relativeToStaging = relative(canonicalStaging, destination);
      if (relativeToStaging.startsWith("..") || relativeToStaging === "") {
        throw new Error(`refusing to write outside the release directory: ${JSON.stringify(relativePath)}`);
      }
      // …and a third: the parent directory a member lands in must still be
      // inside the store once resolved, so a directory member cannot redirect
      // later members of the same layer out of the release.
      mkdirSync(dirname(destination), { recursive: true });
      resolveInsideStore(storeRoot, dirname(destination), "release member directory");
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

    // Containment first, existence second. Checking only existence would let a
    // traversing entrypoint pass whenever the file it points at happens to be
    // there — which is precisely the case worth refusing.
    const entrypoint = assertContainedEntrypoint(canonicalStaging, config.entrypoint);
    assertRegularFile(entrypoint, config.entrypoint, "after unpack");

    mkdirSync(dirname(target), { recursive: true });
    resolveInsideStore(storeRoot, dirname(target), "connector directory");
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return describeRelease(resolveInsideStore(storeRoot, target, "release directory"), config, pinned, storeRoot);
}

/**
 * Require that a path is a *regular file*, not merely present.
 *
 * `existsSync` follows symlinks and is true for directories, so on its own it
 * answers a weaker question than the one that matters: the runner is about to
 * be handed this path to execute. `lstat` is used rather than `stat` so a
 * symlink is refused as a symlink instead of being judged by its target.
 */
function assertRegularFile(resolved: string, declared: string, when: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new Error(`artifact declares entrypoint ${JSON.stringify(declared)} but it is absent ${when}`);
  }
  if (!stats.isFile()) {
    throw new Error(
      `artifact declares entrypoint ${JSON.stringify(declared)} but ${resolved} is not a regular file ${when}`
    );
  }
}

function describeRelease(
  directory: string,
  config: VerifiedArtifact["config"],
  pinned: VerifiedArtifact["pinned"],
  storeRoot: string
): InstalledRelease {
  // Re-checked here rather than trusted from the install path: the idempotent
  // branch returns straight from an already-present release directory without
  // unpacking anything, so this is the only gate that entrypoint crosses.
  //
  // Containment is checked against the release directory *and* the release
  // directory is checked against the store root. Containment alone is not
  // enough, because it canonicalizes whatever directory it is handed: a release
  // directory that has already been redirected out of the store becomes the
  // root that the entrypoint is judged "contained" by.
  const canonicalDirectory = resolveInsideStore(storeRoot, directory, "release directory");
  const entrypoint = assertContainedEntrypoint(canonicalDirectory, config.entrypoint);
  // Presence is not enough either: the runner is handed this path to execute,
  // so it must still be a regular file, not a deleted one or a directory.
  assertRegularFile(entrypoint, config.entrypoint, "in the installed release");
  return Object.freeze({
    connectorKey: config.connector_key,
    connectorId: config.connector_id,
    version: config.version,
    digest: pinned.digest,
    directory: canonicalDirectory,
    entrypoint,
  });
}

/**
 * Decide whether an already-present release directory may be reused.
 *
 * Returns `null` when the cached release still matches the authenticated
 * artifact, or a human-readable reason when it does not.
 *
 * This exists because the digest-named directory was being treated as its own
 * evidence. It is not: the name records which artifact was *installed* there,
 * and says nothing about whether the bytes on disk are still those bytes. A
 * release whose executable has been edited, or deleted, keeps its directory
 * name either way. So the cached contents are re-derived from the layers we are
 * currently holding — which reached us through digest verification and
 * signature checking — and compared byte-for-byte.
 *
 * Only the files the installer itself writes are compared. Extra files are not
 * a mismatch: an active collection may legitimately have written scratch state
 * beside the code, and refusing those would break the running case this is
 * meant to protect.
 */
function cachedReleaseMatches(directory: string, artifact: VerifiedArtifact): string | null {
  const { config, layers } = artifact;

  const expected = new Map<string, Uint8Array>();
  const profileBytes = layers.get(LAYER_MEDIA_TYPES.profile);
  if (profileBytes !== undefined) expected.set("collection-profile.json", profileBytes);
  const provenanceBytes = layers.get(LAYER_MEDIA_TYPES.provenance);
  if (provenanceBytes !== undefined) expected.set("provenance.json", provenanceBytes);
  expected.set("config.json", new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`));
  expected.set(
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
    for (const member of readTarGz(blob)) expected.set(join(prefix, member.path), member.bytes);
  }

  for (const [relativePath, bytes] of expected) {
    const candidate = join(directory, relativePath);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(candidate);
    } catch {
      return `${relativePath} is missing`;
    }
    // `lstat`, so a file swapped for a symlink is a mismatch even when the
    // symlink target happens to hold the right bytes.
    if (!stats.isFile()) return `${relativePath} is not a regular file`;
    if (stats.size !== bytes.byteLength) return `${relativePath} has the wrong size`;
    if (!Buffer.from(readFileSync(candidate)).equals(Buffer.from(bytes))) {
      return `${relativePath} does not match the verified artifact`;
    }
  }
  return null;
}

/**
 * Move an invalid cached release aside so it can be rebuilt from verified bytes.
 *
 * ## What a repair does to a collection that is already running
 *
 * This used to claim that renaming "leaves the running process's open paths
 * resolving to the quarantined directory". That is **false for pathname
 * lookups**, and the difference matters enough to state precisely rather than
 * imply:
 *
 *  - **Already-open descriptors and already-loaded module code survive.** A
 *    descriptor holds an inode, and a rename does not disturb it; a module
 *    whose body Node has already evaluated keeps running.
 *  - **Any read that resolves a pathname *after* the repair does not.** The
 *    absolute paths a running collection captured earlier — including the
 *    `import.meta.url`-relative sibling paths a connector uses for its own
 *    scratch state — name the *canonical* release directory. The rename moves
 *    the old contents out of that name and the reinstall writes fresh verified
 *    bytes into it. So a later `readFileSync(join(here, "scratch-state.json"))`
 *    does not follow the moved directory: it hits the replacement release,
 *    where that scratch file does not exist, and throws `ENOENT`. Executed
 *    counterexample, and the test named "…a running module's pathname reads"
 *    holds this behaviour in place rather than describing it away.
 *
 * **The policy, stated as a limit rather than a guarantee: a cache repair is
 * not safe to perform under an active collection, and this module cannot make
 * it safe.** Protecting active runs properly needs the caller to know no run is
 * in progress — the same knowledge {@link activateRelease} is already gated on
 * by `activate` defaulting to `false`. What is *not* available here is a way to
 * detect a run from inside the installer, so the honest arrangement is: the
 * repair happens (leaving modified code in a content-addressed store is worse),
 * it is loud about having happened, and the limit is written down where someone
 * scheduling a repair will read it.
 *
 * The quarantined copy is therefore kept for two reasons, only one of which was
 * true before: it is **evidence** — the host has just found modified code in a
 * content-addressed store, worth inspecting afterwards — and it is the only
 * place a running collection's scratch state still exists, so a recovery can
 * find it. It is not a live path the running collection keeps reading through.
 */
function quarantineRelease(directory: string, storeRoot: string, reason: string): void {
  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const quarantined = `${directory}.invalid-${stamp}`;
  resolveInsideStore(storeRoot, dirname(quarantined), "quarantine parent directory");
  renameSync(directory, quarantined);
  process.emitWarning(
    `connector release ${directory} did not match its verified artifact (${reason}); ` +
      `moved to ${quarantined} and reinstalling from verified layers. ` +
      `A collection running out of this release keeps its loaded code and open descriptors, but any path it ` +
      `resolves from now on — including its own scratch state beside the code — names the replacement release, ` +
      `not the quarantined copy. Repair under an active collection is not safe; its state is preserved only at ${quarantined}.`,
    "ManagedConnectorCacheWarning"
  );
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
 * absolute path under a digest directory, and an ordinary install writes a new
 * sibling rather than touching it. The one path that does disturb an existing
 * digest directory is a cache repair — see {@link quarantineRelease}, which
 * states plainly what that costs an active run rather than claiming it costs
 * nothing.
 */
export function activateRelease(installRoot: string, release: InstalledRelease): void {
  const storeRoot = canonicalStoreRoot(installRoot);
  const pointerPath = join(installRoot, "connectors", release.connectorKey, "current.json");
  mkdirSync(dirname(pointerPath), { recursive: true });
  // The pointer decides what runs next, so its parent is held to the same
  // boundary as the release itself: a redirected `connectors/<key>` would
  // otherwise write the activation record outside the store.
  resolveInsideStore(storeRoot, dirname(pointerPath), "activation pointer directory");

  const payload = `${JSON.stringify({ digest: release.digest, version: release.version, activatedAt: new Date().toISOString() }, null, 2)}\n`;
  const temporary = createExclusiveTemporary(storeRoot, pointerPath, payload);
  try {
    renameSync(temporary, pointerPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Write the activation payload to a fresh temporary leaf beside the pointer,
 * refusing to write through anything already sitting at that path.
 *
 * Checking the temporary file's *parent* is not enough, and that gap was real:
 * with a parent that resolves correctly inside the store, a plain
 * `writeFileSync` at a predictable leaf follows a symlink planted there and
 * writes activation JSON through it. Planting
 * `current.json.tmp-<pid>` → a durable `archive.json` was therefore enough to
 * replace a collected archive's bytes and leave `current.json` a symlink whose
 * realpath is still that archive. The leaf name was guessable (the process ID
 * is not a secret) and no race was needed, so the concurrent-replacement
 * qualification on {@link resolveInsideStore} did not cover it.
 *
 * Two independent things close it, and both are kept because they fail for
 * different reasons:
 *
 *  - **`wx` (`O_CREAT|O_EXCL|O_WRONLY`).** The kernel refuses `O_EXCL` when the
 *    final component exists *at all* — including a symlink, which it will not
 *    follow. This is the load-bearing half: it is enforced by the same syscall
 *    that creates the file, so there is no window between deciding the path is
 *    safe and writing to it. A pre-planted leaf is an `EEXIST`, not a write
 *    through to wherever it pointed.
 *  - **An unpredictable name.** 16 bytes of `randomBytes` rather than the
 *    process ID, so an attacker cannot know which leaf to plant in the first
 *    place. On its own this would only be obscurity; behind `O_EXCL` it means
 *    the refusal below is a genuine anomaly rather than routine collision.
 *
 * The created leaf is then checked to be a regular file inside the store before
 * anything is written, so the file being renamed onto the pointer is one this
 * function made.
 */
function createExclusiveTemporary(storeRoot: string, pointerPath: string, payload: string): string {
  const temporary = `${pointerPath}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    // `wx`: create-or-fail. Never `w`, which would follow a symlink at this leaf.
    writeFileSync(temporary, payload, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(
        `refusing to activate through an existing path at ${JSON.stringify(temporary)}: ` +
          `the activation temporary must be created fresh, never written through something already there`,
        { cause: error }
      );
    }
    throw error;
  }

  try {
    // The parent was checked above; this checks the leaf itself, which is the
    // component the previous version never looked at.
    const stats = lstatSync(temporary);
    if (!stats.isFile()) {
      throw new Error(`activation temporary ${JSON.stringify(temporary)} is not a regular file`);
    }
    resolveInsideStore(storeRoot, temporary, "activation temporary file");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  return temporary;
}
