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
  /** Test hook that simulates a legacy collector write after the first snapshot. */
  beforeMigrationReconcile?: (() => void) | undefined;
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
 * store is never merged into or silently preferred: the outbox orders work by
 * insertion, so appending an old backlog (checkpoints, terminal commits) after
 * newer canonical rows could replay stale state. Resolution fails with
 * `legacy_state_conflict` and leaves the legacy store writable. A retirement
 * fence counts as a completed migration only when the canonical database holds
 * the same per-attempt migration id; an unproven fence is lifted, never trusted.
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

  if (existsSync(canonicalPath)) {
    if (containsSourceRows(canonicalPath, sourceInstanceId)) {
      // A canonical copy with rows is authoritative only if no package-local
      // store still holds an unmigrated backlog. Source rows alone do not show
      // that the migration ran: a concurrent run can create the canonical queue
      // first. A retirement fence does not show it either; only the canonical
      // database carrying the fence's migration id does. The state directory
      // itself is skipped because its stores are used in place and are never
      // retired.
      const unmigrated: string[] = [];
      let legacyWritable = true;
      for (const path of findMatchingLegacyStores({
        canonicalPath,
        roots: roots.filter((root) => root !== stateDirectory),
        sourceInstanceId,
      })) {
        if (isWithin(stateDirectory, path)) {
          continue;
        }
        const status = inspectLegacyStore(path, canonicalPath, sourceInstanceId);
        if (status.fence === "proven") {
          continue;
        }
        if (status.fence === "unproven") {
          const lifted = recoverUnprovenFence(path, canonicalPath, sourceInstanceId, status.migrationId);
          legacyWritable = legacyWritable && lifted;
        }
        if (status.pending) {
          unmigrated.push(path);
        }
      }
      if (unmigrated.length > 0) {
        throw conflictingLegacyState(canonicalPath, unmigrated, sourceInstanceId, legacyWritable);
      }
      return canonicalPath;
    }
    // An empty canonical database while another legacy store has rows: fail
    // closed rather than turning an interrupted/manual initialization into
    // silent data loss. A canonical queue whose rows were all delivered and
    // pruned is also empty, but it still carries the migration marker its
    // legacy store's fence names, so that legacy store is accounted for.
    const unaccounted: string[] = [];
    for (const path of findMatchingLegacyStores({ canonicalPath, roots, sourceInstanceId })) {
      const status = inspectLegacyStore(path, canonicalPath, sourceInstanceId);
      if (status.fence === "proven") {
        continue;
      }
      unaccounted.push(path);
      if (status.fence === "unproven") {
        // An interrupted migration can leave a fence behind; this canonical file
        // cannot be its product, so the legacy writer must not stay retired.
        recoverUnprovenFence(path, canonicalPath, sourceInstanceId, status.migrationId);
      }
    }
    if (unaccounted.length > 0) {
      throw ambiguousLegacyState(canonicalPath, unaccounted, sourceInstanceId);
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
    linkFile: input.linkFile,
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
  /**
   * `proven`: a retirement fence whose migration id the canonical database
   * carries. `unproven`: a fence the canonical database does not vouch for.
   */
  fence: "none" | "proven" | "unproven";
  migrationId: string | null;
  /** Undelivered work remains for the source. */
  pending: boolean;
}

/**
 * Read a legacy store's undelivered work and retirement fence. Delivered
 * (`succeeded`) rows are retained history, and a dead-letter terminal commit
 * retired by the supersession ledger is superseded history; neither is pending.
 * The pending rule is the outbox's own `activeOutboxRowPredicate`, so draining
 * the lane with the collector always clears what this reports.
 */
function inspectLegacyStore(path: string, canonicalPath: string, sourceInstanceId: string): LegacyStoreStatus {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const tableExists = (name: string) =>
      Boolean(db?.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (!tableExists("local_device_outbox")) {
      return { fence: "none", migrationId: null, pending: false };
    }
    const activeRule = tableExists(SUPERSESSION_TABLE) ? `AND ${activeOutboxRowPredicate()}` : "";
    const pending = Boolean(
      db
        .prepare(
          `SELECT 1 AS present FROM local_device_outbox WHERE source_instance_id = ? AND status != 'succeeded' ${activeRule} LIMIT 1`
        )
        .get(sourceInstanceId)
    );
    if (!tableExists("pdpp_legacy_retirements")) {
      return { fence: "none", migrationId: null, pending };
    }
    const hasMigrationId = retirementHasMigrationId(db);
    const retirement = db
      .prepare(
        `SELECT ${hasMigrationId ? "migration_id" : "NULL"} AS migration_id FROM pdpp_legacy_retirements WHERE source_instance_id = ?`
      )
      .get(sourceInstanceId);
    if (!retirement) {
      return { fence: "none", migrationId: null, pending };
    }
    const migrationId = typeof retirement.migration_id === "string" ? retirement.migration_id : null;
    const proven = migrationId !== null && readCanonicalMigrationId(canonicalPath, sourceInstanceId) === migrationId;
    return { fence: proven ? "proven" : "unproven", migrationId, pending };
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
 * Return a legacy store to a writable state when its fence is not backed by the
 * canonical database. Refuses while a live handoff holds the lock, because that
 * handoff may still be about to publish. Returns whether the store is writable.
 */
function recoverUnprovenFence(
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  migrationId: string | null
): boolean {
  assertNoHandoffInProgress(canonicalPath);
  return liftRetirementFence(legacyPath, sourceInstanceId, migrationId);
}

type MigrationHooks = Pick<
  CollectorStatePathInput,
  "afterMigrationInstall" | "afterRetirementFence" | "beforeMigrationReconcile" | "linkFile"
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
  hooks: MigrationHooks
): string {
  mkdirSync(dirname(canonicalPath), { mode: 0o700, recursive: true });
  const migrationId = randomUUID();
  let published = false;
  const temporaryPath = `${canonicalPath}.migration-${process.pid}-${randomUUID()}.tmp`;
  const lockPath = `${canonicalPath}.handoff.lock`;
  let lockAcquired = false;
  let source: DatabaseSync | undefined;
  try {
    // The snapshot is written beside the final canonical database, so the final
    // rename is between destination siblings. The legacy store may be on a
    // different filesystem: it is only read (VACUUM INTO) and fenced in place.
    acquireMigrationLock(lockPath);
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
    reconcileLegacyWrites(legacyPath, temporaryPath, canonicalPath, sourceInstanceId, migrationId);

    const snapshotFd = openSync(temporaryPath, "r");
    try {
      fsyncSync(snapshotFd);
    } finally {
      closeSync(snapshotFd);
    }

    hooks.afterRetirementFence?.();
    publishSnapshot(temporaryPath, canonicalPath, legacyPath, sourceInstanceId, hooks.linkFile ?? linkSync);
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
    rmSync(temporaryPath, { force: true });
    if (lockAcquired) {
      if (!published) {
        // The fence may have committed without the snapshot being published.
        // Scoped to this attempt's id, so a fence from another attempt stays.
        liftRetirementFence(legacyPath, sourceInstanceId, migrationId);
      }
      releaseMigrationLock(lockPath);
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
  sourceInstanceId: string,
  migrationId: string
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
    // Checked while the legacy database is write-locked and before the fence is
    // committed: a canonical queue that appeared since the snapshot holds work
    // this migration has not seen, so abort with the legacy writer still live.
    if (existsSync(canonicalPath)) {
      throw conflictingLegacyState(canonicalPath, [legacyPath], sourceInstanceId);
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

function acquireMigrationLock(path: string): void {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${process.pid}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    let ownerPid: number | undefined;
    try {
      ownerPid = Number(readFileSync(path, { encoding: "utf8" }).trim());
    } catch (lockReadError) {
      throw new Error(`legacy state handoff is already in progress: ${path}`, { cause: lockReadError });
    }
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
      } catch (probeError) {
        if (isNodeError(probeError) && probeError.code === "ESRCH") {
          rmSync(path, { force: true });
          acquireMigrationLock(path);
          return;
        }
      }
    }
    throw new Error(`legacy state handoff is already in progress: ${path}`, { cause: error });
  }
}

function releaseMigrationLock(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Publish the snapshot at the canonical path without ever replacing a file that
 * appeared since the pre-fence check. link(2) fails with EEXIST instead of
 * overwriting, unlike rename(2). Node has no atomic no-replace rename, so a
 * filesystem without hard links fails closed rather than falling back to a
 * check-then-rename that could overwrite a concurrently created queue. Either
 * way the fence is lifted so the legacy writer is usable again.
 */
function publishSnapshot(
  temporaryPath: string,
  canonicalPath: string,
  legacyPath: string,
  sourceInstanceId: string,
  link: (existingPath: string, newPath: string) => void
): void {
  try {
    link(temporaryPath, canonicalPath);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw conflictingLegacyState(
        canonicalPath,
        [legacyPath],
        sourceInstanceId,
        liftRetirementFence(legacyPath, sourceInstanceId)
      );
    }
    if (isLinkUnsupportedError(error)) {
      const legacyWritable = liftRetirementFence(legacyPath, sourceInstanceId);
      // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
      throw new CollectorStateResolutionError(
        "legacy_state_migration_failed",
        `could not migrate the legacy local collector store for source '${sourceInstanceId}': the filesystem holding ${dirname(canonicalPath)} does not support hard links, which publishing the canonical queue without replacing a concurrently created one requires; ${legacyWritableSentence(legacyWritable)}. Pass --queue ${legacyPath} to keep using the legacy store`,
        { cause: error }
      );
    }
    throw error;
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
 * Delete a source's retirement fence. When `migrationId` is given, only a fence
 * written by that attempt is removed. Returns whether the legacy store is
 * writable again.
 */
function liftRetirementFence(legacyPath: string, sourceInstanceId: string, migrationId?: string | null): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(legacyPath);
    db.exec("PRAGMA busy_timeout = 5000");
    if (migrationId !== undefined && retirementHasMigrationId(db)) {
      db.prepare("DELETE FROM pdpp_legacy_retirements WHERE source_instance_id = ? AND migration_id IS ?").run(
        sourceInstanceId,
        migrationId
      );
    } else {
      db.prepare("DELETE FROM pdpp_legacy_retirements WHERE source_instance_id = ?").run(sourceInstanceId);
    }
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Refuse to hand out a canonical path while a live process holds its handoff lock. */
function assertNoHandoffInProgress(canonicalPath: string): void {
  const lockPath = `${canonicalPath}.handoff.lock`;
  let ownerPid: number;
  try {
    ownerPid = Number(readFileSync(lockPath, { encoding: "utf8" }).trim());
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
  try {
    process.kill(ownerPid, 0);
  } catch (probeError) {
    if (isNodeError(probeError) && probeError.code === "ESRCH") {
      return;
    }
  }
  throw new CollectorStateResolutionError(
    "legacy_state_conflict",
    `a legacy state handoff to ${canonicalPath} is in progress (process ${ownerPid}); retry once it finishes`
  );
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

function legacyWritableSentence(legacyWritable: boolean): string {
  return legacyWritable
    ? "the legacy store was left writable and was not migrated"
    : "the legacy store could not be returned to a writable state; remove its pdpp_legacy_retirements row for this source";
}

function conflictingLegacyState(
  canonicalPath: string,
  legacyPaths: readonly string[],
  sourceInstanceId: string,
  legacyWritable = true
): CollectorStateResolutionError {
  const state = legacyWritableSentence(legacyWritable);
  return new CollectorStateResolutionError(
    "legacy_state_conflict",
    `local collector state for source '${sourceInstanceId}' exists in both the canonical queue ${canonicalPath} and an unmigrated legacy store (${legacyPaths.join(", ")}); ${state}. The two cannot be merged safely because queue order carries checkpoints and terminal commits. Deliver the legacy backlog first by running the collector once with --queue ${legacyPaths.join(" ")}, then rerun; or pass --queue to choose one store explicitly`
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

function isLinkUnsupportedError(error: unknown): boolean {
  return isNodeError(error) && ["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
