// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's Node module registry does not yet recognize node:sqlite; Node and tsc resolve the built-in module.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { activeOutboxRowPredicate } from "../../collector-runtime/src/local-device-outbox.ts";

const SQLITE_HEADER = "SQLite format 3\u0000";
const MAX_LEGACY_ENTRIES_PER_ROOT = 64;
const LEGACY_SQLITE_FILE_PATTERN = /(?:\.sqlite|\.db|\.json)$/;
const LEGACY_MIGRATION_FILE_PATTERN = /\.migration-[^/]+\.tmp$/;
const DEFAULT_QUEUE_FILE_NAME = "collector-runner-queue.sqlite";
const SUPERSESSION_TABLE = "local_device_terminal_commit_supersessions";
const MIGRATION_MARKER_TABLE = "pdpp_migration_marker";

export interface CollectorStatePathInput {
  /** Test hook that simulates a legacy collector write after canonical installation. */
  afterMigrationInstall?: (() => void) | undefined;
  /** Test hook that simulates a crash after the legacy retirement fence commits. */
  afterRetirementFence?: (() => void) | undefined;
  /**
   * Test hook run while publication holds the legacy write lock, after it has
   * re-verified the fence and before it links the snapshot into place.
   */
  betweenPublishRecheckAndLink?: (() => void) | undefined;
  /** Test hook that simulates a legacy collector write after the first snapshot. */
  beforeMigrationReconcile?: (() => void) | undefined;
  /**
   * Test hook run while recovery holds the legacy write lock, after it has looked
   * for a fence owner's marker and before it looks at the owner's handoff lock.
   */
  betweenFenceMarkerAndLockChecks?: (() => void) | undefined;
  /** A queue path supplied by an operator or profile. */
  configuredPath?: string | null | undefined;
  /** Whether `configuredPath` came from an explicit queue configuration. */
  configuredPathIsExplicit?: boolean | undefined;
  connectorId?: string | null | undefined;
  /** Additional bounded legacy roots, primarily for deterministic tests. */
  legacyRoots?: readonly string[] | undefined;
  /** Test hook replacing link(2), used to simulate a filesystem without hard links. */
  linkFile?: ((existingPath: string, newPath: string) => void) | undefined;
  /** Injectable module URL used to locate the old package-relative store. */
  moduleUrl?: string | URL | undefined;
  /** The source identity that must remain isolated from other lanes. */
  sourceInstanceId?: string | null | undefined;
  /** Injectable platform state root for deterministic tests. */
  stateRoot?: string | undefined;
}

export class CollectorStateResolutionError extends Error {
  readonly code:
    | "legacy_state_ambiguous"
    | "legacy_state_conflict"
    | "legacy_state_unreadable"
    | "legacy_state_migration_failed";

  constructor(code: CollectorStateResolutionError["code"], message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CollectorStateResolutionError";
    this.code = code;
  }
}

/**
 * Resolve the platform's per-user state root. This intentionally has no cwd or
 * module-path input: package lifecycle must not change where durable work is
 * stored.
 */
export function defaultCollectorStateRoot(
  input: { env?: Readonly<Record<string, string | undefined>>; home?: string; platform?: NodeJS.Platform } = {}
): string {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome && isAbsolute(xdgStateHome) && platform !== "win32" && platform !== "darwin") {
    return xdgStateHome;
  }
  if (platform === "win32") {
    return env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return join(home, ".local", "state");
}

/** Directory used by the canonical local-collector durable outbox. */
export function collectorStateDirectory(stateRoot = defaultCollectorStateRoot()): string {
  return join(stateRoot, "pdpp", "collectors");
}

/**
 * Compute the canonical source-aware path without touching the filesystem.
 * Source ids are encoded as one filename segment, so a connector cannot escape
 * the state directory even if a future server emits a separator.
 */
export function canonicalCollectorQueuePath(input: {
  connectorId?: string | null | undefined;
  sourceInstanceId?: string | null | undefined;
  stateRoot?: string | undefined;
}): string {
  const directory = collectorStateDirectory(input.stateRoot);
  const sourceInstanceId = input.sourceInstanceId?.trim();
  const connectorId = input.connectorId?.trim();
  if (!sourceInstanceId) {
    return join(directory, DEFAULT_QUEUE_FILE_NAME);
  }
  const sourceSegment = safeStatePathSegment(sourceInstanceId);
  const fileName = connectorId
    ? `${safeStatePathSegment(connectorId)}.${sourceSegment}.sqlite`
    : `collector-runner-queue.${sourceSegment}.sqlite`;
  return join(directory, fileName);
}

/**
 * Resolve the local collector's durable outbox path.
 *
 * Explicit paths are returned before any default lookup. For an unconfigured
 * source-aware default, the resolver first uses the canonical user-state path,
 * then looks through a small set of known legacy roots. A stable legacy store
 * is used in place; a package-local legacy store is reconciled into a
 * consistent SQLite snapshot, retires the migrated source in the old
 * database, and installs the snapshot at the canonical path. Old pathnames
 * are never removed.
 *
 * A canonical queue that already exists next to an unmigrated package-local
 * store is never merged into or deleted: the outbox orders work by insertion,
 * so appending an old backlog (checkpoints, terminal commits) after newer
 * canonical rows could replay stale state. A retirement fence counts as a
 * completed migration only when the canonical database holds the same
 * per-attempt migration id.
 *
 * The collector keeps running on the canonical queue, with a stderr warning on
 * every resolution, only when all of these hold; any other case is refused:
 * - the canonical database holds the source (otherwise `legacy_state_conflict`,
 *   or `legacy_state_ambiguous` at start-up);
 * - exactly one legacy store has pending rows for it (several are
 *   `legacy_state_ambiguous`: the operator must choose);
 * - that store is writable for the source. A fence on it is classified under the
 *   legacy write lock: this attempt's own fence, or one whose attempt died before
 *   publishing, is lifted; a fence another queue published or is publishing
 *   behind, or one from an older release, stays and is refused;
 * - nothing suggests its rows were already published to a queue that has since
 *   been removed. A fence whose queue no longer exists is kept and refused,
 *   because missing proof does not show the publication never happened.
 */
export function resolveCollectorQueuePath(input: CollectorStatePathInput = {}): string {
  const { configuredPath, configuredPathIsExplicit } = input;
  const isExplicit = configuredPathIsExplicit ?? Boolean(configuredPath?.trim());
  if (isExplicit && typeof configuredPath === "string") {
    return configuredPath;
  }

  const stateRoot = input.stateRoot ?? defaultCollectorStateRoot();
  const stateDirectory = collectorStateDirectory(stateRoot);
  const historicalStableDirectory =
    input.stateRoot === undefined && process.platform !== "win32"
      ? join(homedir(), ".local", "state", "pdpp", "collectors")
      : undefined;
  const canonicalPath = canonicalCollectorQueuePath({
    connectorId: input.connectorId,
    sourceInstanceId: input.sourceInstanceId,
    stateRoot,
  });
  const sourceInstanceId = input.sourceInstanceId?.trim();
  if (!sourceInstanceId) {
    return canonicalPath;
  }

  const roots = legacyRoots({
    extraRoots: input.legacyRoots,
    historicalStableDirectory,
    packageDataRoot: packageDataRoot(input.moduleUrl),
    stateDirectory,
    stateRoot,
  });

  // A canonical copy with rows is authoritative only if no package-local store
  // still holds an unmigrated backlog. Source rows alone do not show that the
  // migration ran: a concurrent run can create the canonical queue first. A
  // retirement fence does not show it either; only the canonical database
  // carrying the fence's migration id does. The state directory itself is
  // skipped because its stores are used in place and are never retired.
  const accountForPopulatedCanonical = () =>
    accountForLegacyStores(
      findMatchingLegacyStores({
        canonicalPath,
        roots: roots.filter((root) => root !== stateDirectory),
        sourceInstanceId,
      }).filter((path) => !isWithin(stateDirectory, path)),
      canonicalPath,
      sourceInstanceId,
      { betweenFenceChecks: input.betweenFenceMarkerAndLockChecks, holdUnprovenFences: true }
    );

  if (existsSync(canonicalPath)) {
    if (containsSourceRows(canonicalPath, sourceInstanceId)) {
      return keepRunningOnCanonical(canonicalPath, accountForPopulatedCanonical(), sourceInstanceId);
    }
    // An empty canonical database while another legacy store has undelivered
    // work: fail closed rather than turning an interrupted/manual initialization
    // into silent data loss. A canonical queue whose rows were all delivered and
    // pruned is also empty, but it still carries the migration marker its legacy
    // store's fence names; a legacy store with no active work has nothing to lose.
    const pending = accountForLegacyStores(
      findMatchingLegacyStores({ canonicalPath, roots, sourceInstanceId }),
      canonicalPath,
      sourceInstanceId,
      { betweenFenceChecks: input.betweenFenceMarkerAndLockChecks, holdUnprovenFences: true }
    );
    if (pending.length > 0) {
      throw ambiguousLegacyState(canonicalPath, pending, sourceInstanceId);
    }
    return canonicalPath;
  }

  const matches = findMatchingLegacyStores({ canonicalPath, roots, sourceInstanceId });
  if (matches.length === 0) {
    // The canonical file is created by the caller, outside this module. While
    // another process holds the handoff lock, creating it here would race the
    // installation of the migrated snapshot.
    assertNoHandoffInProgress(canonicalPath);
    return canonicalPath;
  }
  if (matches.length > 1) {
    throw ambiguousLegacyState(canonicalPath, matches, sourceInstanceId);
  }

  const [legacyPath] = matches;
  if (!legacyPath) {
    return canonicalPath;
  }
  if (isWithin(stateDirectory, legacyPath)) {
    return legacyPath;
  }
  return migrateLegacyStore(legacyPath, canonicalPath, sourceInstanceId, {
    afterMigrationInstall: input.afterMigrationInstall,
    afterRetirementFence: input.afterRetirementFence,
    beforeMigrationReconcile: input.beforeMigrationReconcile,
    betweenPublishRecheckAndLink: input.betweenPublishRecheckAndLink,
    linkFile: input.linkFile,
    rediscoverBacklog: accountForPopulatedCanonical,
  });
}

function legacyRoots(input: {
  extraRoots?: readonly string[] | undefined;
  historicalStableDirectory?: string | undefined;
  packageDataRoot: string;
  stateDirectory: string;
  stateRoot: string;
}): string[] {
  return deduplicatePaths([
    input.stateDirectory,
    ...(input.historicalStableDirectory ? [input.historicalStableDirectory] : []),
    join(input.stateRoot, "pdpp"),
    input.packageDataRoot,
    ...(input.extraRoots ?? []),
  ]);
}

function packageDataRoot(moduleUrl?: string | URL): string {
  const resolvedModuleUrl = moduleUrl ?? import.meta.url;
  const modulePath =
    typeof resolvedModuleUrl === "string" && !resolvedModuleUrl.startsWith("file:")
      ? resolvedModuleUrl
      : fileURLToPath(resolvedModuleUrl);
  // The built module is dist/local-collector/src/durable-state.js and the old
  // package-relative queue lived at dist/local-collector/.pdpp-data.
  return join(dirname(dirname(modulePath)), ".pdpp-data");
}

function findMatchingLegacyStores(input: {
  canonicalPath: string;
  roots: readonly string[];
  sourceInstanceId: string;
}): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const root of input.roots) {
    for (const candidate of candidateFiles(root)) {
      if (candidate === input.canonicalPath || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (!isSqliteDatabase(candidate)) {
        continue;
      }
      if (containsSourceRows(candidate, input.sourceInstanceId)) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

function candidateFiles(root: string): string[] {
  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = readdirSync(root, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not inspect the local collector state directory ${root}`,
      { cause: error }
    );
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && LEGACY_SQLITE_FILE_PATTERN.test(entry.name))
    .map((entry) => join(root, entry.name))
    .filter((path) => !LEGACY_MIGRATION_FILE_PATTERN.test(path))
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length > MAX_LEGACY_ENTRIES_PER_ROOT) {
    throw new CollectorStateResolutionError(
      "legacy_state_ambiguous",
      `legacy local collector state discovery exceeded its ${MAX_LEGACY_ENTRIES_PER_ROOT}-file bound in ${root}; pass --queue explicitly`
    );
  }
  return candidates;
}

function isSqliteDatabase(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length && header.toString("utf8") === SQLITE_HEADER;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not read legacy state candidate ${path}`,
      {
        cause: error,
      }
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** Read only the indexed source identity; payload JSON is never selected. */
function containsSourceRows(path: string, sourceInstanceId: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'local_device_outbox'")
      .get();
    if (!table) {
      return false;
    }
    return Boolean(
      db
        .prepare("SELECT 1 AS present FROM local_device_outbox WHERE source_instance_id = ? LIMIT 1")
        .get(sourceInstanceId)
    );
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not inspect legacy local collector state candidate ${path}`,
      { cause: error }
    );
  } finally {
    db?.close();
  }
}

interface LegacyStoreStatus {
  /** The retirement fence in the store, if any. */
  fence: FenceRecord | null;
  /** Undelivered work remains for the source. */
  pending: boolean;
}

/** A retirement fence row: the destination it was written for and the attempt that wrote it. */
interface FenceRecord {
  migrationId: string | null;
  recordedPath: string;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function readFenceRecord(db: DatabaseSync, sourceInstanceId: string): FenceRecord | null {
  if (!tableExists(db, "pdpp_legacy_retirements")) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT canonical_path, ${retirementHasMigrationId(db) ? "migration_id" : "NULL"} AS migration_id FROM pdpp_legacy_retirements WHERE source_instance_id = ?`
    )
    .get(sourceInstanceId);
  if (!row) {
    return null;
  }
  return {
    migrationId: typeof row.migration_id === "string" ? row.migration_id : null,
    recordedPath: String(row.canonical_path),
  };
}

/**
 * Read a legacy store's undelivered work and retirement fence. Delivered
 * (`succeeded`) rows are retained history, and a dead-letter terminal commit
 * retired by the supersession ledger is superseded history; neither is pending.
 * The pending rule is the outbox's own `activeOutboxRowPredicate`, so draining
 * the lane with the collector always clears what this reports.
 *
 * The fence is only an observation for routing. Every decision about a fence is
 * taken again under the legacy write lock (`settleFence`).
 */
function inspectLegacyStore(path: string, sourceInstanceId: string): LegacyStoreStatus {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    if (!tableExists(db, "local_device_outbox")) {
      return { fence: null, pending: false };
    }
    const activeRule = tableExists(db, SUPERSESSION_TABLE) ? `AND ${activeOutboxRowPredicate()}` : "";
    const pending = Boolean(
      db
        .prepare(
          `SELECT 1 AS present FROM local_device_outbox WHERE source_instance_id = ? AND status != 'succeeded' ${activeRule} LIMIT 1`
        )
        .get(sourceInstanceId)
    );
    return { fence: readFenceRecord(db, sourceInstanceId), pending };
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not inspect legacy local collector state candidate ${path}`,
      { cause: error }
    );
  } finally {
    db?.close();
  }
}

/** The migration id a canonical database recorded when its snapshot was taken, if any. */
function readCanonicalMigrationId(canonicalPath: string, sourceInstanceId: string): string | null {
  if (!existsSync(canonicalPath)) {
    return null;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(canonicalPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MIGRATION_MARKER_TABLE);
    if (!table) {
      return null;
    }
    const row = db
      .prepare(`SELECT migration_id FROM ${MIGRATION_MARKER_TABLE} WHERE source_instance_id = ?`)
      .get(sourceInstanceId);
    return typeof row?.migration_id === "string" ? row.migration_id : null;
  } finally {
    db?.close();
  }
}

function retirementHasMigrationId(db: DatabaseSync): boolean {
  return db
    .prepare("PRAGMA table_info(pdpp_legacy_retirements)")
    .all()
    .some((column) => column.name === "migration_id");
}

/**
 * Whether the destination a fence was written for still binds the legacy store.
 *
 * - `published`: the destination carries the fence's migration id. A fence with
 *   no migration id was written by a release that did not record one; it only ever
 *   installed the fence right before an atomic rename, so the destination existing
 *   is the proof, and such a fence is never lifted.
 * - `live`: the attempt that wrote the fence still holds its handoff lock.
 * - `orphan`: a fence with no migration id and no destination. Nothing proves
 *   whether that release finished, so it is neither trusted nor lifted.
 * - `none`: an id-carrying fence nothing backs; its attempt died before publishing.
 *
 * Only meaningful while the legacy write lock is held, because publication needs
 * that lock too: no attempt can publish between the two observations.
 */
function fenceIsPublished(fence: FenceRecord, sourceInstanceId: string): boolean {
  return fence.migrationId === null
    ? existsSync(fence.recordedPath)
    : readCanonicalMigrationId(fence.recordedPath, sourceInstanceId) === fence.migrationId;
}

type FenceBinding = { kind: "published" } | { kind: "live"; pid: number } | { kind: "orphan" } | { kind: "none" };

function fenceBinding(
  fence: FenceRecord,
  sourceInstanceId: string,
  betweenChecks?: (() => void) | undefined,
  heldHandoff?: string | undefined
): FenceBinding {
  const published = fenceIsPublished(fence, sourceInstanceId);
  betweenChecks?.();
  if (published) {
    return { kind: "published" };
  }
  // The caller holds the handoff lock of `heldHandoff`, so its owner is not a rival.
  const pid = fence.recordedPath === heldHandoff ? undefined : liveHandoffOwner(fence.recordedPath);
  if (pid !== undefined) {
    return { kind: "live", pid };
  }
  return fence.migrationId === null ? { kind: "orphan" } : { kind: "none" };
}

/**
 * The fence verdicts that need no lock: a published fence stays published, so
 * observing the proof once, read-only, is final. Anything else (an attempt that
 * may still publish, or a fence that might be lifted) needs `settleFence`.
 */
function settlePublishedFenceReadOnly(
  fence: FenceRecord,
  requestedPath: string,
  sourceInstanceId: string
): "foreign" | "proven" | undefined {
  let published: boolean;
  try {
    published = fenceIsPublished(fence, sourceInstanceId);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not read the destination ${fence.recordedPath} that a retirement fence names`,
      { cause: error }
    );
  }
  if (!published) {
    return undefined;
  }
  return fence.recordedPath === requestedPath ? "proven" : "foreign";
}

type FenceVerdict =
  | { kind: "foreign" | "orphan" | "proven" | "unproven" }
  | { kind: "lift"; migrationId: string };

/**
 * Classify a fence for a request for `requestedPath`. Callers hold the legacy
 * write lock, so the verdict cannot be overtaken.
 *
 * - `proven`: the requested destination carries the fence's migration id.
 * - `foreign`: another destination published, or is publishing, behind the fence.
 * - `orphan`: an id-less fence to a missing destination; it is never lifted.
 * - `lift`: no destination binds the fence, so its attempt died before publishing.
 * - `unproven`: like `lift`, but the destination is gone and `holdUnproven` is set.
 *   Missing proof does not show the publication never happened: the snapshot may
 *   have been published, delivered, and the queue removed since. A destination
 *   that exists without the fence's id was taken by someone else, so link(2)
 *   could not have published there.
 *
 * `heldHandoff` is the destination whose handoff lock the caller holds.
 */
function judgeFence(
  current: FenceRecord,
  requestedPath: string,
  sourceInstanceId: string,
  options: {
    betweenChecks?: (() => void) | undefined;
    heldHandoff?: string | undefined;
    holdUnproven?: boolean | undefined;
  } = {}
): FenceVerdict {
  const binding = fenceBinding(current, sourceInstanceId, options.betweenChecks, options.heldHandoff);
  if (binding.kind === "orphan") {
    return { kind: "orphan" };
  }
  if (binding.kind === "none" && current.migrationId !== null) {
    if (options.holdUnproven && !existsSync(current.recordedPath)) {
      return { kind: "unproven" };
    }
    return { kind: "lift", migrationId: current.migrationId };
  }
  if (current.recordedPath !== requestedPath) {
    return { kind: "foreign" };
  }
  if (binding.kind === "live") {
    throw handoffInProgress(requestedPath, binding.pid);
  }
  return { kind: "proven" };
}

/**
 * Decide an observed fence under the legacy write lock. That lock is the one
 * serialization point for fence decisions: installing, publishing behind and
 * lifting a fence all take it, so the verdict here cannot be overtaken.
 *
 * - `absent`: the fence is already gone.
 * - `lifted`: no destination binds the fence, so it was deleted.
 * - `unproven`: see `judgeFence`; the fence is left in place.
 * - the other verdicts are `judgeFence`'s, and leave the fence in place.
 *
 * A fence that changed since it was observed is not decided at all.
 */
function settleFence(
  legacyPath: string,
  requestedPath: string,
  sourceInstanceId: string,
  observed: FenceRecord,
  options: { betweenChecks?: (() => void) | undefined; holdUnproven?: boolean | undefined } = {}
): "absent" | "foreign" | "lifted" | "orphan" | "proven" | "unproven" {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(legacyPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = readFenceRecord(db, sourceInstanceId);
      if (!current) {
        db.exec("ROLLBACK");
        return "absent";
      }
      if (current.recordedPath !== observed.recordedPath || current.migrationId !== observed.migrationId) {
        throw new CollectorStateResolutionError(
          "legacy_state_conflict",
          `the retirement of ${legacyPath} for source '${sourceInstanceId}' changed while it was being checked; retry`
        );
      }
      const verdict = judgeFence(current, requestedPath, sourceInstanceId, options);
      if (verdict.kind === "lift") {
        deleteFence(db, sourceInstanceId, verdict.migrationId);
        db.exec("COMMIT");
        return "lifted";
      }
      db.exec("ROLLBACK");
      return verdict.kind;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction already ended; keep the original failure.
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof CollectorStateResolutionError) {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not settle the retirement of legacy local collector state ${legacyPath}`,
      { cause: error }
    );
  } finally {
    db?.close();
  }
}

/**
 * Classify the legacy stores that match a source once its canonical queue exists.
 * Returns the stores still holding undelivered work, each writable for the source.
 * Fences backed by a published or in-flight destination are left in place; fences
 * nothing backs are lifted, unless `holdUnprovenFences` asks to keep one whose
 * destination is gone and the store has pending rows (see `judgeFence`).
 */
function accountForLegacyStores(
  paths: readonly string[],
  canonicalPath: string,
  sourceInstanceId: string,
  options: { betweenFenceChecks?: (() => void) | undefined; holdUnprovenFences?: boolean | undefined } = {}
): string[] {
  const pending: string[] = [];
  for (const path of paths) {
    const status = inspectLegacyStore(path, sourceInstanceId);
    const { fence, pending: hasPending } = status;
    if (fence && settleObservedFence(path, fence, hasPending, canonicalPath, sourceInstanceId, options) === "retired") {
      continue;
    }
    if (hasPending) {
      pending.push(path);
    }
  }
  return pending;
}

/**
 * Settle the fence observed on a legacy store. Returns `retired` when the fence
 * stays and the store holds nothing to report, and `writable` when no fence is
 * left on it. A fence that stays over a pending backlog is refused.
 */
function settleObservedFence(
  path: string,
  fence: FenceRecord,
  hasPending: boolean,
  canonicalPath: string,
  sourceInstanceId: string,
  options: { betweenFenceChecks?: (() => void) | undefined; holdUnprovenFences?: boolean | undefined }
): "retired" | "writable" {
  const verdict =
    settlePublishedFenceReadOnly(fence, canonicalPath, sourceInstanceId) ??
    settleFence(path, canonicalPath, sourceInstanceId, fence, {
      betweenChecks: options.betweenFenceChecks,
      holdUnproven: options.holdUnprovenFences === true && hasPending,
    });
  if (verdict === "absent" || verdict === "lifted") {
    return "writable";
  }
  // Not trusted and not lifted; only a backlog still sitting here is a conflict.
  if (hasPending) {
    if (verdict === "orphan") {
      throw orphanFence(path, fence.recordedPath, sourceInstanceId);
    }
    if (verdict === "foreign") {
      throw foreignFenceConflict(path, fence.recordedPath, canonicalPath, sourceInstanceId);
    }
    if (verdict === "unproven") {
      throw lostPublicationConflict(path, fence.recordedPath, canonicalPath, sourceInstanceId);
    }
  }
  return "retired";
}

function foreignFenceConflict(
  legacyPath: string,
  recordedPath: string,
  requestedPath: string,
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `the legacy store ${legacyPath} for source '${sourceInstanceId}' is retired to ${recordedPath}, not to the requested ${requestedPath}; its fence was left in place. Use the queue at ${recordedPath} (--queue ${recordedPath}), or wait for a handoff to it that is still running`
  );
}

function orphanFence(
  legacyPath: string,
  recordedPath: string,
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `the legacy store ${legacyPath} for source '${sourceInstanceId}' carries a retirement fence from an older release that points at ${recordedPath}, which does not exist. The fence was left in place and the legacy store stays retired; remove the fence deliberately only after confirming no queue was delivered from ${recordedPath}`
  );
}

function handoffInProgress(
  canonicalPath: string,
  ownerPid: number | undefined,
  cause?: unknown
): CollectorStateResolutionError {
  const owner = ownerPid ? ` (process ${ownerPid})` : "";
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `a legacy state handoff to ${canonicalPath} is in progress${owner}; retry once it finishes`,
    cause === undefined ? {} : { cause }
  );
}

/** The fence an attempt's own fence replaced, shared so a failure anywhere can put it back. */
interface FenceClaim {
  superseded: FenceRecord | null;
}

type MigrationHooks = Pick<
  CollectorStatePathInput,
  | "afterMigrationInstall"
  | "afterRetirementFence"
  | "beforeMigrationReconcile"
  | "betweenPublishRecheckAndLink"
  | "linkFile"
>;

/**
 * Each attempt has a fresh migration id, written into both the snapshot (as its
 * marker) and the legacy retirement fence. The fence alone only records that an
 * attempt reached the commit; the canonical database carrying the same id is
 * what proves this attempt's snapshot was published.
 */
function migrateLegacyStore(
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  hooks: MigrationHooks & {
    /** Legacy stores still holding work once a populated canonical queue exists. */
    rediscoverBacklog: () => string[];
  }
): string {
  mkdirSync(dirname(canonicalPath), { mode: 0o700, recursive: true });
  const migrationId = randomUUID();
  let published = false;
  const temporaryPath = `${canonicalPath}.migration-${process.pid}-${randomUUID()}.tmp`;
  const lockPath = `${canonicalPath}.handoff.lock`;
  let lockAcquired = false;
  let source: DatabaseSync | undefined;
  // The fence this attempt's own fence replaced, filled before that fence commits.
  const claim: FenceClaim = { superseded: null };
  try {
    // The snapshot is written beside the final canonical database, so the final
    // rename is between destination siblings. The legacy store may be on a
    // different filesystem: it is only read (VACUUM INTO) and fenced in place.
    acquireMigrationLock(lockPath, canonicalPath);
    lockAcquired = true;
    source = new DatabaseSync(legacyPath, { readOnly: true });
    source.exec("PRAGMA busy_timeout = 5000");
    const escapedPath = temporaryPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedPath}'`);
    source.close();
    source = undefined;
    if (process.platform !== "win32") {
      chmodSync(temporaryPath, 0o600);
    }

    hooks.beforeMigrationReconcile?.();
    reconcileLegacyWrites(legacyPath, temporaryPath, canonicalPath, sourceInstanceId, migrationId, claim);

    const snapshotFd = openSync(temporaryPath, "r");
    try {
      fsyncSync(snapshotFd);
    } finally {
      closeSync(snapshotFd);
    }

    hooks.afterRetirementFence?.();
    publishSnapshot(
      temporaryPath,
      canonicalPath,
      legacyPath,
      sourceInstanceId,
      migrationId,
      hooks.linkFile ?? linkSync,
      hooks.betweenPublishRecheckAndLink,
      claim.superseded
    );
    published = true;
    settlePublishedSnapshot(canonicalPath);
    hooks.afterMigrationInstall?.();
    if (lockAcquired) {
      releaseMigrationLock(lockPath);
    }
    rmSync(temporaryPath, { force: true });
    return canonicalPath;
  } catch (error) {
    source?.close();
    let restoredFence: FenceRecord | null = null;
    if (lockAcquired) {
      try {
        if (!published) {
          // The fence may have committed without the snapshot being published.
          // Scoped to this attempt's id, so a fence from another attempt stays.
          // A fence this attempt replaced whose queue is gone is put back.
          restoredFence = giveBackOwnFence(legacyPath, sourceInstanceId, migrationId, claim.superseded);
        }
      } finally {
        releaseMigrationLock(lockPath);
      }
    }
    // Last, and best effort: the temporary snapshot holds no authority, so a
    // failure to remove it must not skip the fence restore or the lock release.
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Left for a later migration attempt to ignore.
    }
    if (restoredFence) {
      // The superseded fence may stand for a publication that was delivered and
      // removed, so no advice here may point at draining the legacy store.
      throw uncertainPublicationConflict(legacyPath, restoredFence.recordedPath, canonicalPath, sourceInstanceId, error);
    }
    if (error instanceof CanonicalQueueAppeared) {
      // The legacy store was made writable under its write lock. The canonical
      // queue is only a destination for this source if it holds the source.
      if (!containsSourceRows(canonicalPath, sourceInstanceId)) {
        throw conflictingLegacyState(canonicalPath, legacyPath, sourceInstanceId);
      }
      // Stores may have gained work since discovery; account for all of them.
      return keepRunningOnCanonical(canonicalPath, hooks.rediscoverBacklog(), sourceInstanceId);
    }
    if (error instanceof CollectorStateResolutionError) {
      throw error;
    }
    if (published) {
      // The legacy store is fenced and the canonical queue holds its work, so the
      // only valid queue is the canonical one.
      // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
      throw new CollectorStateResolutionError(
        "legacy_state_migration_failed",
        `the legacy local collector store for source '${sourceInstanceId}' was migrated to ${canonicalPath}, but finishing the handoff failed; the legacy store is retired, so do not select it with --queue. Rerun to use ${canonicalPath}`,
        { cause: error }
      );
    }
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_migration_failed",
      `could not migrate the unique legacy local collector store for source '${sourceInstanceId}'; the original store was retained and --queue can select it explicitly`,
      { cause: error }
    );
  }
}

/**
 * Fence the still-running legacy collector while reconciling writes that
 * landed after VACUUM INTO's snapshot. BEGIN IMMEDIATE waits for any current
 * writer, then prevents another writer until the rows are copied and a
 * trigger-enforced retirement fence is committed in the legacy database.
 * The canonical pathname is a separate complete snapshot; it never aliases
 * the legacy WAL main file or its path-derived sidecars.
 *
 * Records in `claim` the fence this attempt's own fence replaces, if any.
 */
function reconcileLegacyWrites(
  legacyPath: string,
  temporaryPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  migrationId: string,
  claim: FenceClaim
): void {
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(legacyPath);
    source.exec("PRAGMA busy_timeout = 5000");
    source.exec("BEGIN IMMEDIATE");
    const escapedPath = temporaryPath.replaceAll("'", "''");
    source.exec(`ATTACH DATABASE '${escapedPath}' AS migrated`);
    // VACUUM INTO can carry an earlier retirement fence into the snapshot
    // during crash recovery. The fence belongs only to the legacy pathname;
    // copying it to the canonical authority would retire the new writer too.
    source.exec(`
      DROP TRIGGER IF EXISTS migrated.pdpp_retire_outbox_insert;
      DROP TRIGGER IF EXISTS migrated.pdpp_retire_outbox_update;
      DROP TRIGGER IF EXISTS migrated.pdpp_retire_outbox_delete;
      DROP TABLE IF EXISTS migrated.pdpp_legacy_retirements;
      DROP TABLE IF EXISTS migrated.${MIGRATION_MARKER_TABLE};
      CREATE TABLE migrated.${MIGRATION_MARKER_TABLE} (
        source_instance_id TEXT PRIMARY KEY,
        migration_id TEXT NOT NULL
      );
      INSERT INTO migrated.${MIGRATION_MARKER_TABLE} (source_instance_id, migration_id)
        VALUES (${sqlStringLiteral(sourceInstanceId)}, ${sqlStringLiteral(migrationId)});
    `);
    reconcileSourceRows(source, sourceInstanceId);
    // Checked while the legacy database is write-locked and before the fence is
    // committed: a canonical queue that appeared since the snapshot holds work
    // this migration has not seen, so abort. The caller may keep running on that
    // queue only if the legacy writer is live, so any fence another attempt left
    // is judged here, under the lock, and no fence may remain.
    if (existsSync(canonicalPath)) {
      makeLegacyWritableForAppearedQueue(source, legacyPath, canonicalPath, sourceInstanceId);
      source.exec("COMMIT");
      throw new CanonicalQueueAppeared();
    }
    // Claim the source's retirement under the same write lock. A fence another
    // destination published, or is publishing, behind is never replaced; one
    // nothing backs belongs to a dead attempt and is taken over.
    // A fence without a migration id (older release) is never taken over for
    // another destination; for this destination, whose queue does not exist, it
    // belongs to an interrupted handoff to the same path and is retried.
    const existing = readFenceRecord(source, sourceInstanceId);
    claim.superseded = existing;
    if (existing && existing.recordedPath !== canonicalPath) {
      const binding = fenceBinding(existing, sourceInstanceId);
      if (binding.kind === "orphan") {
        // Advising --queue here would create the recorded path and make this fence look proven.
        throw orphanFence(legacyPath, existing.recordedPath, sourceInstanceId);
      }
      if (existing.migrationId === null || binding.kind !== "none") {
        throw foreignFenceConflict(legacyPath, existing.recordedPath, canonicalPath, sourceInstanceId);
      }
    }
    installRetirementFence(source, sourceInstanceId, canonicalPath, migrationId);
    source.exec("COMMIT");
    source.exec("DETACH DATABASE migrated");
  } catch (error) {
    try {
      source?.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  } finally {
    source?.close();
  }
}

const OUTBOX_COLUMNS = [
  "kind",
  "status",
  "payload_json",
  "body_hash",
  "attempt_count",
  "next_attempt_at",
  "lease_holder",
  "lease_epoch",
  "lease_until",
  "last_error",
  "acknowledged_at",
  "created_at",
  "updated_at",
] as const;

/**
 * Bring the snapshot's rows for the source to the legacy store's current state.
 * The caller holds the legacy write lock, so this is the last state the legacy
 * writer can produce. VACUUM INTO took the snapshot earlier, so rows may since
 * have been added, acknowledged, re-leased, dead-lettered or pruned: copying only
 * new rows would leave a stale `ready` row that the canonical queue re-delivers.
 * Existing rows are updated in place (not replaced) to keep their insertion order.
 */
function reconcileSourceRows(db: DatabaseSync, sourceInstanceId: string): void {
  const source = sqlStringLiteral(sourceInstanceId);
  const columns = OUTBOX_COLUMNS.join(", ");
  db.exec(`
    DELETE FROM migrated.local_device_outbox
     WHERE source_instance_id = ${source}
       AND id NOT IN (SELECT id FROM main.local_device_outbox WHERE source_instance_id = ${source});
    UPDATE migrated.local_device_outbox AS t
       SET ${OUTBOX_COLUMNS.map((column) => `${column} = m.${column}`).join(", ")}
      FROM main.local_device_outbox AS m
     WHERE t.id = m.id AND t.source_instance_id = ${source} AND m.source_instance_id = ${source};
    INSERT OR IGNORE INTO migrated.local_device_outbox (id, source_instance_id, ${columns})
    SELECT id, source_instance_id, ${columns}
      FROM main.local_device_outbox
     WHERE source_instance_id = ${source}
     ORDER BY rowid;
  `);
  if (tableExistsIn(db, "migrated", "local_device_observed_stream")) {
    db.exec(`
      DELETE FROM migrated.local_device_observed_stream
       WHERE source_instance_id = ${source}
         AND NOT EXISTS (
           SELECT 1 FROM main.local_device_observed_stream AS m
            WHERE m.source_instance_id = migrated.local_device_observed_stream.source_instance_id
              AND m.stream = migrated.local_device_observed_stream.stream
              AND m.outbox_id = migrated.local_device_observed_stream.outbox_id
         );
      INSERT OR IGNORE INTO migrated.local_device_observed_stream (outbox_id, source_instance_id, stream)
      SELECT outbox_id, source_instance_id, stream
        FROM main.local_device_observed_stream
       WHERE source_instance_id = ${source};
    `);
  }
  if (tableExistsIn(db, "migrated", SUPERSESSION_TABLE) && tableExistsIn(db, "main", SUPERSESSION_TABLE)) {
    // Append-only ledger: add links that name one of the source's rows.
    db.exec(`
      INSERT OR IGNORE INTO migrated.${SUPERSESSION_TABLE}
        (retired_terminal_commit_id, replacement_terminal_commit_id, superseded_at)
      SELECT retired_terminal_commit_id, replacement_terminal_commit_id, superseded_at
        FROM main.${SUPERSESSION_TABLE}
       WHERE retired_terminal_commit_id IN (SELECT id FROM main.local_device_outbox WHERE source_instance_id = ${source})
          OR replacement_terminal_commit_id IN (SELECT id FROM main.local_device_outbox WHERE source_instance_id = ${source});
    `);
  }
}

function tableExistsIn(db: DatabaseSync, schema: "main" | "migrated", name: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 AS present FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name)
  );
}

/**
 * A canonical queue appeared while this attempt held the legacy write lock and
 * its handoff lock, before it installed its own fence. Judge a fence another
 * attempt left, in the caller's open write transaction, and delete it only when
 * it is one that `judgeFence` lifts. Anything else is refused and left in place.
 * Returns only once no fence remains for the source; writability is asserted,
 * not inferred from the queue having appeared.
 */
function makeLegacyWritableForAppearedQueue(
  db: DatabaseSync,
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string
): void {
  const existing = readFenceRecord(db, sourceInstanceId);
  if (existing) {
    const verdict = judgeFence(existing, canonicalPath, sourceInstanceId, {
      heldHandoff: canonicalPath,
      holdUnproven: true,
    });
    switch (verdict.kind) {
      case "lift":
        deleteFence(db, sourceInstanceId, verdict.migrationId);
        break;
      case "orphan":
        throw orphanFence(legacyPath, existing.recordedPath, sourceInstanceId);
      case "foreign":
        throw foreignFenceConflict(legacyPath, existing.recordedPath, canonicalPath, sourceInstanceId);
      case "unproven":
        throw lostPublicationConflict(legacyPath, existing.recordedPath, canonicalPath, sourceInstanceId);
      default:
        throw fenceForAppearedQueue(legacyPath, canonicalPath, sourceInstanceId);
    }
  }
  assertNoFence(db, legacyPath, sourceInstanceId);
}

/** The legacy store accepts writes for the source only while no fence row names it. */
function assertNoFence(db: DatabaseSync, legacyPath: string, sourceInstanceId: string): void {
  if (readFenceRecord(db, sourceInstanceId)) {
    throw new CollectorStateResolutionError(
      "legacy_state_conflict",
      `the retirement fence for source '${sourceInstanceId}' in ${legacyPath} is still in place, so the legacy store cannot be left writable; nothing was published and the original store was retained`
    );
  }
}

/** An empty lock file this young may be an owner between creating and writing it. */
const LOCK_WRITE_GRACE_MS = 2000;

function acquireMigrationLock(path: string, canonicalPath: string): void {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, lockContents(), undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    let owner: LockOwner;
    try {
      owner = readLockOwner(path);
    } catch (lockReadError) {
      // An unreadable lock cannot be shown dead, so it is treated as held.
      throw handoffInProgress(canonicalPath, undefined, lockReadError);
    }
    if (!owner.live) {
      rmSync(path, { force: true });
      acquireMigrationLock(path, canonicalPath);
      return;
    }
    throw handoffInProgress(canonicalPath, owner.pid);
  }
}

interface LockOwner {
  live: boolean;
  pid: number | undefined;
}

/**
 * The handoff lock records the owner's pid plus the identity that distinguishes
 * it from a later process that reuses the pid: its start time (Linux) and the boot
 * id (Linux, when readable). Elsewhere only the pid is recorded.
 */
function lockContents(): string {
  const lines = [String(process.pid)];
  const startTime = processStartTime(process.pid);
  if (startTime !== undefined) {
    lines.push(`start=${startTime}`);
  }
  const bootId = currentBootId();
  if (bootId !== undefined) {
    lines.push(`boot=${bootId}`);
  }
  return `${lines.join("\n")}\n`;
}

function currentBootId(): string | undefined {
  try {
    return (
      readFileSync("/proc/sys/kernel/random/boot_id", {
        encoding: "utf8",
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Clock ticks since boot at which the process started, from /proc/<pid>/stat field 22. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, { encoding: "utf8" });
    // The command name may contain spaces and parentheses; the fields that
    // follow the last ")" are well formed. Field 22 is the 20th after it.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a lock file names a live owner. Only a positive integer pid can
 * be an owner: an empty or garbled file is a dead owner's remains (an empty file
 * is given a short grace for an owner still writing it). A pid whose start time
 * or boot id differs from the recorded one is a reused pid, not the owner. EPERM
 * means the process exists but is not ours to signal; it counts as live only when
 * its identity could not be compared.
 */
function readLockOwner(lockPath: string): LockOwner {
  let text: string;
  try {
    text = readFileSync(lockPath, { encoding: "utf8" });
  } catch (error) {
    if (isNotFoundError(error)) {
      return { live: false, pid: undefined };
    }
    throw error;
  }
  const [pidLine = "", ...identityLines] = text.trim().split("\n");
  if (text.trim() === "") {
    let young = false;
    try {
      young = Date.now() - statSync(lockPath).mtimeMs < LOCK_WRITE_GRACE_MS;
    } catch {
      // The lock vanished; it has no owner.
    }
    return { live: young, pid: undefined };
  }
  const pid = /^\d+$/.test(pidLine.trim()) ? Number(pidLine.trim()) : Number.NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { live: false, pid: undefined };
  }
  const identity = new Map<string, string>();
  for (const line of identityLines) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      identity.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }
  const recordedBoot = identity.get("boot");
  const bootId = currentBootId();
  if (recordedBoot !== undefined && bootId !== undefined && recordedBoot !== bootId) {
    return { live: false, pid };
  }
  try {
    process.kill(pid, 0);
  } catch (probeError) {
    if (isNodeError(probeError) && probeError.code === "ESRCH") {
      return { live: false, pid };
    }
    // EPERM or anything else: the process exists; fall through to identity.
  }
  const recordedStart = identity.get("start");
  const startTime = recordedStart === undefined ? undefined : processStartTime(pid);
  if (recordedStart !== undefined && startTime !== undefined && recordedStart !== startTime) {
    return { live: false, pid };
  }
  return { live: true, pid };
}

function releaseMigrationLock(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Publish the snapshot at the canonical path without ever replacing a file that
 * appeared since the pre-fence check. link(2) fails with EEXIST instead of
 * overwriting, unlike rename(2). Node has no atomic no-replace rename, so a
 * filesystem without hard links fails closed rather than falling back to a
 * check-then-rename that could overwrite a concurrently created queue.
 *
 * The legacy write lock is held from the moment this attempt's fence is
 * re-verified until link returns. Recovery and other destinations need that lock
 * to lift or replace the fence, so none of them can act on a stale view of a
 * snapshot that is being published. If the fence is no longer this attempt's,
 * nothing is published. If the link fails, the fence is lifted in the same
 * transaction so the legacy writer is usable again. If a competing creator wins
 * the path and this attempt had replaced a fence whose queue is gone, that fence
 * is put back instead (see `judgeFence`).
 */
function publishSnapshot(
  temporaryPath: string,
  canonicalPath: string,
  legacyPath: string,
  sourceInstanceId: string,
  migrationId: string,
  link: (existingPath: string, newPath: string) => void,
  betweenRecheckAndLink?: (() => void) | undefined,
  supersededFence?: FenceRecord | null | undefined
): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(legacyPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const fence = readFenceRecord(db, sourceInstanceId);
    if (fence?.migrationId !== migrationId || fence.recordedPath !== canonicalPath) {
      throw new CollectorStateResolutionError(
        "legacy_state_conflict",
        `the retirement fence for source '${sourceInstanceId}' in ${legacyPath} was lifted or replaced before ${canonicalPath} could be published; nothing was published and the original store was retained`
      );
    }
    try {
      betweenRecheckAndLink?.();
      link(temporaryPath, canonicalPath);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        const restored = returnPriorFence(db, sourceInstanceId, migrationId, supersededFence ?? null);
        if (restored) {
          // The older fence's queue is gone: it may have been published and delivered.
          db.exec("COMMIT");
          throw lostPublicationConflict(legacyPath, restored.recordedPath, canonicalPath, sourceInstanceId);
        }
        assertNoFence(db, legacyPath, sourceInstanceId);
        db.exec("COMMIT");
        throw new CanonicalQueueAppeared();
      }
      if (isLinkUnsupportedError(error)) {
        const restored = returnPriorFence(db, sourceInstanceId, migrationId, supersededFence ?? null);
        db.exec("COMMIT");
        if (restored) {
          throw uncertainPublicationConflict(legacyPath, restored.recordedPath, canonicalPath, sourceInstanceId, error);
        }
        // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
        throw new CollectorStateResolutionError(
          "legacy_state_migration_failed",
          `could not migrate the legacy local collector store for source '${sourceInstanceId}': the filesystem holding ${dirname(canonicalPath)} does not support hard links, which publishing the canonical queue without replacing a concurrently created one requires; the legacy store was left writable and was not migrated. Pass --queue ${legacyPath} to keep using the legacy store`,
          { cause: error }
        );
      }
      throw error;
    }
  } finally {
    // Closing the connection ends a transaction that was left open, which
    // releases the legacy write lock after a successful link.
    db?.close();
  }
}

/** Make a published canonical database durable and owner-only. */
function settlePublishedSnapshot(canonicalPath: string): void {
  if (process.platform !== "win32") {
    chmodSync(canonicalPath, 0o600);
  }
  const canonicalFd = openSync(canonicalPath, "r");
  try {
    fsyncSync(canonicalFd);
  } finally {
    closeSync(canonicalFd);
  }
  const directoryFd = openSync(dirname(canonicalPath), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

/**
 * Delete a source's retirement fence, but only the one written by `migrationId`.
 * Callers that may need to put a replaced fence back use `returnPriorFence`.
 */
function deleteFence(db: DatabaseSync, sourceInstanceId: string, migrationId: string): void {
  // A store without the column holds only id-less fences, which are never deleted.
  if (retirementHasMigrationId(db)) {
    db.prepare("DELETE FROM pdpp_legacy_retirements WHERE source_instance_id = ? AND migration_id = ?").run(
      sourceInstanceId,
      migrationId
    );
  }
}

/**
 * Give up the fence a failed attempt wrote, in the caller's open write
 * transaction. It is scoped to the attempt's own migration id, and the attempt
 * never published, so no other destination can depend on it. A fence this
 * attempt replaced whose queue is gone is put back instead of lost: that queue
 * may have been published, delivered and removed. Returns the fence put back.
 */
function returnPriorFence(
  db: DatabaseSync,
  sourceInstanceId: string,
  migrationId: string,
  superseded: FenceRecord | null
): FenceRecord | null {
  if (superseded?.migrationId && !existsSync(superseded.recordedPath)) {
    const result = db
      .prepare(
        "UPDATE pdpp_legacy_retirements SET canonical_path = ?, migration_id = ? WHERE source_instance_id = ? AND migration_id = ?"
      )
      .run(superseded.recordedPath, superseded.migrationId, sourceInstanceId, migrationId);
    return Number(result.changes) > 0 ? superseded : null;
  }
  deleteFence(db, sourceInstanceId, migrationId);
  return null;
}

/**
 * Best-effort cleanup of the fence a failed attempt wrote, for failures outside
 * the publish step. Returns the superseded fence that was put back, if any.
 */
function giveBackOwnFence(
  legacyPath: string,
  sourceInstanceId: string,
  migrationId: string,
  superseded: FenceRecord | null
): FenceRecord | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(legacyPath);
    db.exec("PRAGMA busy_timeout = 5000");
    if (!tableExists(db, "pdpp_legacy_retirements")) {
      return null;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const restored = returnPriorFence(db, sourceInstanceId, migrationId, superseded);
      db.exec("COMMIT");
      return restored;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch {
    // The original failure is what the caller reports.
    return null;
  } finally {
    db?.close();
  }
}

/** The pid of a live process holding the handoff lock for a canonical path, if any. */
function liveHandoffOwner(canonicalPath: string): number | undefined {
  const owner = readLockOwner(`${canonicalPath}.handoff.lock`);
  return owner.live ? (owner.pid ?? 0) : undefined;
}

/** Refuse to hand out a canonical path while a live process holds its handoff lock. */
function assertNoHandoffInProgress(canonicalPath: string): void {
  const ownerPid = liveHandoffOwner(canonicalPath);
  if (ownerPid !== undefined) {
    throw handoffInProgress(canonicalPath, ownerPid);
  }
}

function installRetirementFence(
  source: DatabaseSync,
  sourceInstanceId: string,
  canonicalPath: string,
  migrationId: string
): void {
  const sourceLiteral = sqlStringLiteral(sourceInstanceId);
  const canonicalLiteral = sqlStringLiteral(canonicalPath);
  source.exec(`
    CREATE TABLE IF NOT EXISTS pdpp_legacy_retirements (
      source_instance_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      migration_id TEXT
    );
  `);
  if (!retirementHasMigrationId(source)) {
    source.exec("ALTER TABLE pdpp_legacy_retirements ADD COLUMN migration_id TEXT");
  }
  source.exec(`
    CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_insert
      BEFORE INSERT ON local_device_outbox
      WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = NEW.source_instance_id)
      BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_update
      BEFORE UPDATE ON local_device_outbox
      WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = OLD.source_instance_id OR source_instance_id = NEW.source_instance_id)
      BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_delete
      BEFORE DELETE ON local_device_outbox
      WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = OLD.source_instance_id)
      BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    INSERT INTO pdpp_legacy_retirements (source_instance_id, canonical_path, migration_id)
      VALUES (${sourceLiteral}, ${canonicalLiteral}, ${sqlStringLiteral(migrationId)})
      ON CONFLICT(source_instance_id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        migration_id = excluded.migration_id;
  `);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ambiguousLegacyState(
  canonicalPath: string,
  matches: readonly string[],
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_ambiguous",
    `ambiguous local collector state for source '${sourceInstanceId}': ${matches.length} nonempty legacy stores match; pass --queue explicitly. Canonical path is ${canonicalPath}`
  );
}

/**
 * Another process created the canonical queue while this attempt migrated. By the
 * time this is thrown the legacy store holds no fence for the source (asserted
 * under its write lock); the caller still checks that the queue holds the source.
 */
class CanonicalQueueAppeared extends Error {
  constructor() {
    super("a canonical queue appeared during the legacy migration");
    this.name = "CanonicalQueueAppeared";
  }
}

/**
 * The canonical queue holds the source. Keep running on it, and warn, while one
 * legacy store still has pending rows; several are the operator's decision.
 */
function keepRunningOnCanonical(canonicalPath: string, pending: readonly string[], sourceInstanceId: string): string {
  const [legacyPath, ...others] = pending;
  if (legacyPath === undefined) {
    return canonicalPath;
  }
  if (others.length > 0) {
    throw ambiguousLegacyState(canonicalPath, pending, sourceInstanceId);
  }
  warnAboutLegacyBacklog(canonicalPath, legacyPath, sourceInstanceId);
  return canonicalPath;
}

/**
 * Warn, on stderr, when a writable legacy store still holds undelivered rows for
 * the source. The warning repeats on every resolution until the rows are
 * delivered or removed; a store without such rows is silent.
 */
function warnAboutLegacyBacklog(canonicalPath: string, legacyPath: string, sourceInstanceId: string): void {
  const pending = countPendingSourceRows(legacyPath, sourceInstanceId);
  if (pending === 0) {
    return;
  }
  process.stderr.write(
    `warning: the canonical local collector queue ${canonicalPath} exists for source '${sourceInstanceId}' while the legacy queue ${legacyPath} still holds ${pending} pending row(s) for it. The legacy queue was left writable and was not merged or deleted; running on the canonical queue. Run with --queue ${legacyPath} to deliver them.\n`
  );
}

function conflictingLegacyState(
  canonicalPath: string,
  legacyPath: string,
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `local collector state for source '${sourceInstanceId}' exists in both the canonical queue ${canonicalPath} and an unmigrated legacy store (${legacyPath}); the legacy store was left writable and was not migrated. The two cannot be merged safely because queue order carries checkpoints and terminal commits. Deliver the legacy backlog first by running the collector once with --queue ${legacyPath}, then rerun; or pass --queue to choose one store explicitly`
  );
}

/** The fence names a queue that no longer exists, so its rows may already have been delivered from it. */
function lostPublicationConflict(
  legacyPath: string,
  recordedPath: string,
  canonicalPath: string,
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `the legacy store ${legacyPath} for source '${sourceInstanceId}' carries a retirement fence recorded for ${recordedPath}, which no longer exists, while the canonical queue ${canonicalPath} exists. Nothing shows whether ${recordedPath} was published and delivered the legacy rows before it was removed, so the legacy store was not drained, merged or migrated and its fence was left in place. Pass --queue ${canonicalPath} to continue on the canonical queue once you have confirmed that those rows were delivered or are no longer needed`
  );
}

/**
 * A migration failed after replacing a fence whose queue no longer exists. That
 * queue may have been published, delivered and removed, so the legacy copy may
 * hold delivered rows: the restored fence stays, and no remedy drains it.
 */
function uncertainPublicationConflict(
  legacyPath: string,
  recordedPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  cause: unknown
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_migration_failed",
    `could not migrate the legacy store ${legacyPath} for source '${sourceInstanceId}' to ${canonicalPath}. It carries a retirement fence recorded for ${recordedPath}, which no longer exists, and nothing shows whether ${recordedPath} was published and delivered the legacy rows before it was removed. The fence was left in place and the legacy store was not drained, merged or migrated. Confirm what ${recordedPath} delivered before choosing any queue for this source`,
    { cause }
  );
}

/** The fence already names the requested queue, which appeared while this attempt was migrating. */
function fenceForAppearedQueue(
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `the legacy store ${legacyPath} for source '${sourceInstanceId}' already carries a retirement fence recorded for the requested queue ${canonicalPath}, which appeared while this attempt was migrating; nothing was published and the fence was left in place. Rerun to resolve against the existing queue`
  );
}

function countPendingSourceRows(path: string, sourceInstanceId: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    if (!tableExists(db, "local_device_outbox")) {
      return 0;
    }
    // The same pending rule as inspectLegacyStore, so the warning counts exactly
    // the rows that make resolution treat the legacy store as holding work.
    const activeRule = tableExists(db, SUPERSESSION_TABLE) ? `AND ${activeOutboxRowPredicate()}` : "";
    const row = db
      .prepare(
        `SELECT COUNT(*) AS pending FROM local_device_outbox WHERE source_instance_id = ? AND status != 'succeeded' ${activeRule}`
      )
      .get(sourceInstanceId);
    return Number(row?.pending ?? 0);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not count pending rows in legacy local collector state ${path}`,
      { cause: error }
    );
  } finally {
    db?.close();
  }
}

function safeStatePathSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function deduplicatePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim() !== ""))];
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || !(relativePath.startsWith("..") || isAbsolute(relativePath));
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isLinkUnsupportedError(error: unknown): boolean {
  return isNodeError(error) && ["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
