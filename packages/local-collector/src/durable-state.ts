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
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's Node module registry does not yet recognize node:sqlite; Node and tsc resolve the built-in module.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SQLITE_HEADER = "SQLite format 3\u0000";
const MAX_LEGACY_ENTRIES_PER_ROOT = 64;
const LEGACY_SQLITE_FILE_PATTERN = /(?:\.sqlite|\.db|\.json)$/;
const LEGACY_MIGRATION_FILE_PATTERN = /\.migration-[^/]+\.tmp$/;
const DEFAULT_QUEUE_FILE_NAME = "collector-runner-queue.sqlite";
export interface CollectorStatePathInput {
  /** Test hook that simulates a legacy collector write after canonical installation. */
  afterMigrationInstall?: (() => void) | undefined;
  /** Test hook that simulates a crash after the legacy retirement fence commits. */
  afterRetirementFence?: (() => void) | undefined;
  /** Test hook that simulates another process acting on the queue right after this run linked the canonical name. */
  afterUnderscoreQueueLink?: (() => void) | undefined;
  /** Test hook that simulates another collector acting on an underscore-named queue just before this run folds it. */
  beforeUnderscoreQueueFold?: (() => void) | undefined;
  /** Test hook that simulates a legacy collector write after the first snapshot. */
  beforeMigrationReconcile?: (() => void) | undefined;
  /** A queue path supplied by an operator or profile. */
  configuredPath?: string | null | undefined;
  /** Whether `configuredPath` came from an explicit queue configuration. */
  configuredPathIsExplicit?: boolean | undefined;
  connectorId?: string | null | undefined;
  /** Additional bounded legacy roots, primarily for deterministic tests. */
  legacyRoots?: readonly string[] | undefined;
  /** Injectable module URL used to locate the old package-relative store. */
  moduleUrl?: string | URL | undefined;
  /** The source identity that must remain isolated from other lanes. */
  sourceInstanceId?: string | null | undefined;
  /** Injectable platform state root for deterministic tests. */
  stateRoot?: string | undefined;
}

export class CollectorStateResolutionError extends Error {
  readonly code: "legacy_state_ambiguous" | "legacy_state_unreadable" | "legacy_state_migration_failed";

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

/** SQLite sidecar suffixes that travel with a database file. */
const QUEUE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * Fold a queue's write-ahead log into the main database file so the main file
 * alone holds every committed row. The file must already exist: the open uses
 * SQLite's `mode=rw`, which never creates it, so a source another process has
 * just moved away is reported as `missing` instead of being recreated empty.
 * `unprovable` means the fold cannot be proven: the file is not a readable
 * database, another process holds it (a running collector), or a sidecar still
 * has content afterwards. Callers then leave the file where it is.
 */
function foldQueueIntoMainFile(path: string): "folded" | "missing" | "unprovable" {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(`${pathToFileURL(path).href}?mode=rw`);
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
    if (row?.busy) {
      return "unprovable";
    }
  } catch {
    return existsSync(path) ? "unprovable" : "missing";
  } finally {
    db?.close();
  }
  const sidecarsEmpty = QUEUE_SIDECAR_SUFFIXES.every((suffix) => {
    const sidecar = `${path}${suffix}`;
    return !existsSync(sidecar) || statSync(sidecar).size === 0;
  });
  return sidecarsEmpty ? "folded" : "unprovable";
}

/**
 * One-time migration of a queue file named before connector ids were manifest
 * keys. An older collector named the queue with the underscore spelling
 * (`claude_code.<source>.sqlite`); the same queue is now
 * `claude-code.<source>.sqlite`. When only the underscore-named file exists, its
 * write-ahead log is first folded into the main file, so the main file is
 * complete on its own, and then the main file is renamed. Empty sidecars left
 * behind are removed. If the fold cannot be proven (the file is held by a
 * running collector, or unreadable), nothing is renamed and no row is lost.
 * When the hyphen-named file exists it is authoritative and the
 * underscore-named file is left untouched; if that file still holds pending
 * rows for the source, every run warns with the path to deliver them from.
 * A second run finds nothing to do, and nothing reads the old spelling
 * anywhere else.
 *
 * Two collectors can start together and both see the legacy file and no
 * canonical one, so the checks alone do not make the move safe. One process
 * owns the move through the same handoff lock as {@link migrateLegacyStore};
 * a second one stops with a named error. Every change to the legacy or
 * canonical name, including dropping the old name after a link, happens under
 * that lock; outside it this function only reads and warns.
 *
 * The lock binds only collectors that run this code. An older collector does
 * not take it, and this code does not make that collector's own migration safe:
 * its check-then-rename can still replace the canonical file. What the steps
 * below do is limit this code's own damage when something outside the lock
 * changes the state under it: the legacy file is opened without creating it,
 * and the canonical name is installed with a hard link, which fails when the
 * name exists instead of replacing the file there.
 */
function migrateUnderscoreSpelledQueue(
  canonicalPath: string,
  connectorId: string | null | undefined,
  sourceInstanceId: string,
  stateRoot: string,
  hooks: { afterLink?: (() => void) | undefined; beforeFold?: (() => void) | undefined } = {}
): void {
  const trimmed = connectorId?.trim();
  if (!trimmed?.includes("-")) {
    return;
  }
  const legacyPath = canonicalCollectorQueuePath({
    connectorId: trimmed.replaceAll("-", "_"),
    sourceInstanceId,
    stateRoot,
  });
  if (legacyPath === canonicalPath || !existsSync(legacyPath)) {
    return;
  }
  // Two different files: nothing to change, only to report. When both names are
  // one file a move is unfinished, and only the lock owner may finish it.
  if (existsSync(canonicalPath) && !isSameFile(canonicalPath, legacyPath)) {
    settleLegacyQueueBesideCanonical(canonicalPath, legacyPath, sourceInstanceId);
    return;
  }
  const lockPath = `${canonicalPath}.handoff.lock`;
  let lock: MigrationLock;
  try {
    lock = acquireMigrationLock(lockPath);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_migration_failed",
      `could not take the lock to move the legacy queue ${legacyPath} to ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  try {
    moveUnderscoreSpelledQueue(canonicalPath, legacyPath, sourceInstanceId, hooks);
  } finally {
    releaseMigrationLock(lock);
  }
}

function moveUnderscoreSpelledQueue(
  canonicalPath: string,
  legacyPath: string,
  sourceInstanceId: string,
  hooks: { afterLink?: (() => void) | undefined; beforeFold?: (() => void) | undefined }
): void {
  // The state the caller checked may have changed before the lock was taken.
  if (!existsSync(legacyPath)) {
    requireQueueAtCanonicalPath(canonicalPath, legacyPath);
    return;
  }
  if (existsSync(canonicalPath)) {
    settleLegacyQueueBesideCanonical(canonicalPath, legacyPath, sourceInstanceId);
    return;
  }
  hooks.beforeFold?.();
  const fold = foldQueueIntoMainFile(legacyPath);
  if (fold === "missing") {
    requireQueueAtCanonicalPath(canonicalPath, legacyPath);
    return;
  }
  if (fold === "unprovable") {
    return;
  }
  for (const suffix of QUEUE_SIDECAR_SUFFIXES) {
    rmSync(`${legacyPath}${suffix}`, { force: true });
  }
  try {
    linkSync(legacyPath, canonicalPath);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      settleLegacyQueueBesideCanonical(canonicalPath, legacyPath, sourceInstanceId);
      return;
    }
    if (isNotFoundError(error)) {
      requireQueueAtCanonicalPath(canonicalPath, legacyPath);
      return;
    }
    throw error;
  }
  hooks.afterLink?.();
  if (isSameFile(canonicalPath, legacyPath)) {
    try {
      unlinkSync(legacyPath);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  } else if (existsSync(legacyPath)) {
    throw new CollectorStateResolutionError(
      "legacy_state_migration_failed",
      `the canonical queue ${canonicalPath} is not the legacy queue ${legacyPath} that was moved to it; the legacy queue was left in place`
    );
  }
  // The old name was dropped by someone else. The move is complete only if the
  // canonical queue is a usable queue.
  requireQueueAtCanonicalPath(canonicalPath, legacyPath);
}

/**
 * A legacy queue beside the canonical one is left alone and reported, with one
 * exception: when both names are the same file, a move that linked the new
 * name was interrupted before it dropped the old one. Dropping it finishes
 * that move and loses nothing. Call it holding the handoff lock whenever the
 * two names can be one file.
 */
function settleLegacyQueueBesideCanonical(canonicalPath: string, legacyPath: string, sourceInstanceId: string): void {
  if (isSameFile(canonicalPath, legacyPath)) {
    rmSync(legacyPath, { force: true });
    return;
  }
  warnLegacyQueuePending({
    canonicalPath,
    legacyPath,
    situation: `the legacy queue ${legacyPath} exists beside the canonical local collector queue ${canonicalPath}`,
    sourceInstanceId,
  });
}

/**
 * The legacy queue is gone. That is a finished move only when a usable queue now
 * sits at the canonical path: another collector moved it there. Anything else
 * means the rows are not where they should be, and the run must say so.
 */
function requireQueueAtCanonicalPath(canonicalPath: string, legacyPath: string): void {
  if (existsSync(canonicalPath) && isSqliteDatabase(canonicalPath) && hasOutboxTable(canonicalPath)) {
    return;
  }
  throw new CollectorStateResolutionError(
    "legacy_state_migration_failed",
    `the legacy queue ${legacyPath} disappeared while it was being moved, and there is no usable queue at ${canonicalPath}`
  );
}

function isSameFile(first: string, second: string): boolean {
  try {
    const a = statSync(first);
    const b = statSync(second);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function hasOutboxTable(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return Boolean(
      db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'local_device_outbox'").get()
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
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
 * are never removed, except that an underscore-spelled queue file is renamed
 * once to its hyphen name (see {@link migrateUnderscoreSpelledQueue}).
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

  migrateUnderscoreSpelledQueue(
    canonicalPath,
    input.connectorId,
    sourceInstanceId,
    stateRoot,
    { afterLink: input.afterUnderscoreQueueLink, beforeFold: input.beforeUnderscoreQueueFold }
  );

  if (existsSync(canonicalPath)) {
    // A fully installed canonical copy is authoritative. If it is an empty
    // database while another legacy store has rows, fail closed rather than
    // turning an interrupted/manual initialization into silent data loss.
    if (containsSourceRows(canonicalPath, sourceInstanceId)) {
      return canonicalPath;
    }
    const legacyMatches = findMatchingLegacyStores({
      canonicalPath,
      roots: legacyRoots({
        extraRoots: input.legacyRoots,
        historicalStableDirectory,
        packageDataRoot: packageDataRoot(input.moduleUrl),
        stateDirectory,
        stateRoot,
      }),
      sourceInstanceId,
    });
    if (legacyMatches.length > 0) {
      throw ambiguousLegacyState(canonicalPath, legacyMatches, sourceInstanceId);
    }
    return canonicalPath;
  }

  const matches = findMatchingLegacyStores({
    canonicalPath,
    roots: legacyRoots({
      extraRoots: input.legacyRoots,
      historicalStableDirectory,
      packageDataRoot: packageDataRoot(input.moduleUrl),
      stateDirectory,
      stateRoot,
    }),
    sourceInstanceId,
  });
  if (matches.length === 0) {
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
  return migrateLegacyStore(
    legacyPath,
    canonicalPath,
    sourceInstanceId,
    input.beforeMigrationReconcile,
    input.afterMigrationInstall,
    input.afterRetirementFence
  );
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

function migrateLegacyStore(
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  beforeReconcile?: (() => void) | undefined,
  afterInstall?: (() => void) | undefined,
  afterRetirementFence?: (() => void) | undefined
): string {
  mkdirSync(dirname(canonicalPath), { mode: 0o700, recursive: true });
  const temporaryPath = `${canonicalPath}.migration-${process.pid}-${randomUUID()}.tmp`;
  const lockPath = `${canonicalPath}.handoff.lock`;
  let lock: MigrationLock | undefined;
  let source: DatabaseSync | undefined;
  try {
    ensureSameFilesystem(legacyPath, canonicalPath);
    lock = acquireMigrationLock(lockPath);
    source = new DatabaseSync(legacyPath, { readOnly: true });
    source.exec("PRAGMA busy_timeout = 5000");
    const escapedPath = temporaryPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedPath}'`);
    source.close();
    source = undefined;
    if (process.platform !== "win32") {
      chmodSync(temporaryPath, 0o600);
    }

    beforeReconcile?.();
    if (reconcileLegacyWrites(legacyPath, temporaryPath, canonicalPath, sourceInstanceId) === "canonical_exists") {
      // An earlier crashed attempt may have left this source fenced.
      liftRetirementFence(legacyPath, sourceInstanceId);
      return abandonMigrationForExistingCanonical(legacyPath, canonicalPath, sourceInstanceId, temporaryPath, lock);
    }

    const snapshotFd = openSync(temporaryPath, "r");
    try {
      fsyncSync(snapshotFd);
    } finally {
      closeSync(snapshotFd);
    }

    afterRetirementFence?.();
    if (installSnapshot(temporaryPath, canonicalPath, sourceInstanceId, legacyPath) === "canonical_exists") {
      return abandonMigrationForExistingCanonical(legacyPath, canonicalPath, sourceInstanceId, temporaryPath, lock);
    }
    afterInstall?.();
    releaseMigrationLock(lock);
    rmSync(temporaryPath, { force: true });
    return canonicalPath;
  } catch (error) {
    source?.close();
    rmSync(temporaryPath, { force: true });
    if (lock) {
      releaseMigrationLock(lock);
    }
    if (error instanceof CollectorStateResolutionError) {
      throw error;
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
 * Another process created the canonical queue while this migration ran. The
 * canonical file is authoritative for the resolver, so this migration must not
 * retire, merge or delete the legacy store: drop the temporary snapshot, free
 * the lock and tell the operator how to deliver the legacy pending rows.
 */
function abandonMigrationForExistingCanonical(
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  temporaryPath: string,
  lock: MigrationLock
): string {
  rmSync(temporaryPath, { force: true });
  releaseMigrationLock(lock);
  warnLegacyQueuePending({
    canonicalPath,
    legacyPath,
    situation: `a canonical local collector queue appeared at ${canonicalPath} while migrating the legacy queue ${legacyPath}`,
    sourceInstanceId,
  });
  return canonicalPath;
}

/**
 * The canonical queue is authoritative, so a legacy queue beside it is never
 * drained by the resolver. Its pending rows are not lost, but only the
 * operator can deliver them; say where they are. This count is a diagnostic,
 * so a legacy file it cannot read does not stop resolution here. An empty
 * canonical queue is different: the legacy scan in resolveCollectorQueuePath
 * fails closed on a file it cannot open, because that file may hold the rows.
 */
function warnLegacyQueuePending(input: {
  canonicalPath: string;
  legacyPath: string;
  situation: string;
  sourceInstanceId: string;
}): void {
  const prefix = `warning: ${input.situation} for source '${input.sourceInstanceId}'. The legacy queue was left writable and was not merged or deleted.`;
  const deliver = `run with --queue ${input.legacyPath} to deliver them`;
  let pending: number;
  try {
    pending = countPendingSourceRows(input.legacyPath, input.sourceInstanceId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${prefix} It could not be read (${reason}), so it may still hold pending rows for this source; ${deliver}.\n`
    );
    return;
  }
  if (pending === 0) {
    return;
  }
  process.stderr.write(`${prefix} It holds ${pending} pending row(s) for this source; ${deliver}.\n`);
}

function countPendingSourceRows(path: string, sourceInstanceId: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'local_device_outbox'")
      .get();
    if (!table) {
      return 0;
    }
    const row = db
      .prepare(
        "SELECT COUNT(*) AS pending FROM local_device_outbox WHERE source_instance_id = ? AND status IN ('ready', 'leased')"
      )
      .get(sourceInstanceId);
    return Number(row?.pending ?? 0);
  } finally {
    db?.close();
  }
}

/**
 * Fence the still-running legacy collector while reconciling writes that
 * landed after VACUUM INTO's snapshot. BEGIN IMMEDIATE waits for any current
 * writer, then prevents another writer until the rows are copied and a
 * trigger-enforced retirement fence is committed in the legacy database.
 * The canonical pathname is a separate complete snapshot; it never aliases
 * the legacy WAL main file or its path-derived sidecars.
 */
function reconcileLegacyWrites(
  legacyPath: string,
  temporaryPath: string,
  canonicalPath: string,
  sourceInstanceId: string
): "canonical_exists" | "reconciled" {
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(legacyPath);
    source.exec("PRAGMA busy_timeout = 5000");
    source.exec("BEGIN IMMEDIATE");
    if (existsSync(canonicalPath)) {
      // Checked under the legacy write lock and before any fence is written.
      source.exec("ROLLBACK");
      return "canonical_exists";
    }
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
    `);
    source.exec(`
      INSERT OR IGNORE INTO migrated.local_device_outbox (
        id, source_instance_id, kind, status, payload_json, body_hash,
        attempt_count, next_attempt_at, lease_holder, lease_epoch,
        lease_until, last_error, acknowledged_at, created_at, updated_at
      )
      SELECT id, source_instance_id, kind, status, payload_json, body_hash,
             attempt_count, next_attempt_at, lease_holder, lease_epoch,
             lease_until, last_error, acknowledged_at, created_at, updated_at
        FROM main.local_device_outbox
       WHERE source_instance_id = '${sourceInstanceId.replaceAll("'", "''")}'
    `);
    const hasObservedStreamTable = source
      .prepare(
        "SELECT 1 AS present FROM migrated.sqlite_master WHERE type = 'table' AND name = 'local_device_observed_stream'"
      )
      .get();
    if (hasObservedStreamTable) {
      source.exec(`
        INSERT OR IGNORE INTO migrated.local_device_observed_stream (outbox_id, source_instance_id, stream)
        SELECT outbox_id, source_instance_id, stream
          FROM main.local_device_observed_stream
         WHERE source_instance_id = '${sourceInstanceId.replaceAll("'", "''")}'
      `);
    }
    installRetirementFence(source, sourceInstanceId, canonicalPath);
    source.exec("COMMIT");
    source.exec("DETACH DATABASE migrated");
    return "reconciled";
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

/** A migration lock this process took. `content` identifies it, so release removes only this lock. */
export interface MigrationLock {
  readonly content: string;
  readonly path: string;
}

/**
 * Take the single-owner lock for a migration. Creation is exclusive, so exactly
 * one process wins. When the file exists the call throws and names it. There is
 * deliberately no takeover of a lock whose owner has exited: two processes that
 * both read a dead owner could each remove the file and each take a fresh one,
 * or one could remove the other's fresh lock, and both would enter. The error
 * says whether the recorded owner is still running; if it is not, the operator
 * deletes the file.
 */
export function acquireMigrationLock(path: string): MigrationLock {
  const content = `${process.pid} ${randomUUID()}\n`;
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, content, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    throw new Error(`legacy state handoff is already in progress: ${path} (${describeLockOwner(path)})`, {
      cause: error,
    });
  }
  return { content, path };
}

function describeLockOwner(path: string): string {
  let ownerPid: number;
  try {
    ownerPid = Number(readFileSync(path, { encoding: "utf8" }).split(/\s+/)[0]);
  } catch {
    return "its owner could not be read";
  }
  if (!(Number.isInteger(ownerPid) && ownerPid > 0)) {
    return "its owner is not recorded; if no collector is running, delete this file and run again";
  }
  try {
    process.kill(ownerPid, 0);
    return `process ${ownerPid} holds it and is running`;
  } catch (probeError) {
    if (isNodeError(probeError) && probeError.code === "ESRCH") {
      return `process ${ownerPid} held it and is no longer running; if no collector is running, delete this file and run again`;
    }
    return `process ${ownerPid} holds it`;
  }
}

/** Remove the lock only when the file still holds this process's own marker. */
export function releaseMigrationLock(lock: MigrationLock): void {
  try {
    if (readFileSync(lock.path, { encoding: "utf8" }) !== lock.content) {
      return;
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
  rmSync(lock.path, { force: true });
}

function installSnapshot(
  temporaryPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  legacyPath: string
): "canonical_exists" | "installed" {
  if (existsSync(canonicalPath)) {
    // The canonical file appeared after this migration's fence committed.
    // Lift the fence so the legacy writer is not stranded behind a snapshot
    // that is being discarded.
    liftRetirementFence(legacyPath, sourceInstanceId);
    return "canonical_exists";
  }
  renameSync(temporaryPath, canonicalPath);
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
  return "installed";
}

/** Remove this source's retirement row; drop the triggers only when no other source remains retired. */
function liftRetirementFence(legacyPath: string, sourceInstanceId: string): void {
  const db = new DatabaseSync(legacyPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      const fenced = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'pdpp_legacy_retirements'")
        .get();
      if (!fenced) {
        db.exec("COMMIT");
        return;
      }
      db.prepare("DELETE FROM pdpp_legacy_retirements WHERE source_instance_id = ?").run(sourceInstanceId);
      const remaining = db.prepare("SELECT 1 AS present FROM pdpp_legacy_retirements LIMIT 1").get();
      if (!remaining) {
        db.exec(`
          DROP TRIGGER IF EXISTS pdpp_retire_outbox_insert;
          DROP TRIGGER IF EXISTS pdpp_retire_outbox_update;
          DROP TRIGGER IF EXISTS pdpp_retire_outbox_delete;
        `);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function ensureSameFilesystem(legacyPath: string, canonicalPath: string): void {
  const legacyDevice = statSync(dirname(legacyPath)).dev;
  const canonicalDevice = statSync(dirname(canonicalPath)).dev;
  if (legacyDevice !== canonicalDevice) {
    throw new Error("legacy state handoff crosses filesystems; refusing a non-atomic migration");
  }
}

function installRetirementFence(source: DatabaseSync, sourceInstanceId: string, canonicalPath: string): void {
  const sourceLiteral = sqlStringLiteral(sourceInstanceId);
  const canonicalLiteral = sqlStringLiteral(canonicalPath);
  source.exec(`
    CREATE TABLE IF NOT EXISTS pdpp_legacy_retirements (
      source_instance_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
    INSERT INTO pdpp_legacy_retirements (source_instance_id, canonical_path)
      VALUES (${sourceLiteral}, ${canonicalLiteral})
      ON CONFLICT(source_instance_id) DO UPDATE SET canonical_path = excluded.canonical_path;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
