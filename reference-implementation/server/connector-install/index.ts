// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verified OCI connector installation.
 *
 * Artifact identity lives here, never in connector_instances.source_binding_json:
 * that field identifies an owner's connection, while this module identifies the
 * executable bytes shared by all connections for a connector.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalConnectorKey } from "../connector-key.ts";
import {
  createFileLocalConnectorSourceStore,
  type LocalConnectorSourceRecord,
  type LocalConnectorSourceStore,
} from "./local-source.ts";

const CORE_MODULE = "@opendatalabs/data-connectors-tools/installer-core";
const MAX_CONFIG_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]*$/;
const MANIFEST_REQUEST = /\/manifests\/(sha256:[0-9a-f]{64})$/;
const BLOB_REQUEST = /\/blobs\/(sha256:[0-9a-f]{64})$/;

export interface ConnectorInstallRecord {
  readonly activatedAt: string;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly configDigest: string;
  readonly connectorId: string;
  readonly digest: string;
  readonly entrypointPath: string;
  readonly entrypointSha256: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly provenancePath: string;
  readonly provenanceSha256: string;
  readonly registry: "ghcr.io";
  readonly repository: string;
  readonly root: string;
  readonly tier: string | null;
  readonly version: string | null;
}

export interface ConnectorCatalogEntry {
  readonly bindings?: Readonly<Record<string, unknown>>;
  readonly catalog_connector_id?: string;
  readonly config_digest?: string;
  /** The safe operational key used by the RI route and install path. */
  readonly connector_id: string;
  readonly connector_key: string;
  readonly digest: string;
  readonly display_name?: string;
  readonly latest?: boolean;
  readonly published_at?: string;
  readonly setup_modality?: string | null;
  readonly tier?: string;
  readonly version?: string;
}

export interface ConnectorCatalogSnapshot {
  readonly entries: readonly ConnectorCatalogEntry[];
  readonly generatedAt?: string;
}

interface InstallerCore {
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY: string;
  fetchCatalog?: (options: Record<string, unknown>) => Promise<unknown>;
  fetchResolvedArtifact?: (
    source: Record<string, unknown>,
    entry: Record<string, unknown>,
    options: Record<string, unknown>
  ) => Promise<unknown>;
  installFromLock: (options: Record<string, unknown>) => Promise<unknown>;
}

export interface ConnectorInstallStore {
  activate: (record: ConnectorInstallRecord) => Promise<void>;
  readonly dataDir?: string;
  deactivate: (connectorId: string) => Promise<void>;
  getActive: (connectorId: string) => Promise<ConnectorInstallRecord | null>;
  getCatalogHighWater: () => Promise<string | null>;
  listActive: () => Promise<readonly ConnectorInstallRecord[]>;
  setCatalogHighWater: (value: string) => Promise<void>;
}

export type ActiveConnectorInspection =
  | { readonly status: "none" }
  | { readonly status: "active"; readonly record: ConnectorInstallRecord; readonly path: string }
  | { readonly status: "invalid"; readonly reason: string };

/** A durable, file-local store. PDPP_DATA_DIR is a persistent volume in production. */
export function createFileConnectorInstallStore(
  dataDir = process.env.PDPP_DATA_DIR || join(process.cwd(), "data")
): ConnectorInstallStore {
  const statePath = join(dataDir, "connector-install-state.json");
  const read = (): Record<string, ConnectorInstallRecord> => {
    if (!existsSync(statePath)) {
      return {};
    }
    const value: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, ConnectorInstallRecord>) : {};
  };
  return {
    activate(record) {
      mkdirSync(dataDir, { recursive: true });
      const next = { ...read(), [record.connectorId]: record };
      const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, statePath);
      return Promise.resolve();
    },
    dataDir,
    deactivate(connectorId) {
      if (!existsSync(statePath)) {
        return Promise.resolve();
      }
      mkdirSync(dataDir, { recursive: true });
      const next = { ...read() };
      delete next[connectorId];
      const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, statePath);
      return Promise.resolve();
    },
    getActive(connectorId) {
      return Promise.resolve(read()[connectorId] ?? null);
    },
    getCatalogHighWater() {
      const path = join(dataDir, "connector-install-catalog-high-water");
      return Promise.resolve(existsSync(path) ? readFileSync(path, "utf8").trim() || null : null);
    },
    listActive() {
      return Promise.resolve(Object.values(read()).sort((a, b) => a.connectorId.localeCompare(b.connectorId)));
    },
    setCatalogHighWater(value) {
      mkdirSync(dataDir, { recursive: true });
      const path = join(dataDir, "connector-install-catalog-high-water");
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${value}\n`, { mode: 0o600 });
      renameSync(temp, path);
      return Promise.resolve();
    },
  };
}

interface InstallRow {
  readonly record_json: string;
}
interface HighWaterRow {
  readonly catalog_high_water: string | null;
}

/** The production durable store. Startup schemas create these same tables. */
export function createConnectorInstallStore(): ConnectorInstallStore {
  const preloadDir = process.env.PDPP_CONNECTOR_PRELOAD_DIR?.trim();
  if (preloadDir) {
    return createFileConnectorInstallStore(preloadDir);
  }
  const dataDir = process.env.PDPP_DATA_DIR || join(process.cwd(), "data");
  const sqlite = async () => {
    const db = await import("../../lib/db.ts");
    db.execDynamicSqlAcknowledged(
      "CREATE TABLE IF NOT EXISTS connector_installs (connector_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    db.execDynamicSqlAcknowledged(
      "CREATE TABLE IF NOT EXISTS connector_install_catalog_state (id INTEGER PRIMARY KEY CHECK (id = 1), catalog_high_water TEXT NOT NULL)"
    );
    return db;
  };
  const postgres = () => import("../postgres-storage.ts");
  const parse = (row: InstallRow | undefined): ConnectorInstallRecord | null =>
    row ? (JSON.parse(row.record_json) as ConnectorInstallRecord) : null;
  return {
    async activate(record) {
      const value = JSON.stringify(record);
      const pg = await postgres();
      if (pg.isPostgresStorageBackend()) {
        await pg.postgresQuery(
          "INSERT INTO connector_installs(connector_id, record_json, updated_at) VALUES ($1, $2, clock_timestamp()::text) ON CONFLICT(connector_id) DO UPDATE SET record_json = EXCLUDED.record_json, updated_at = EXCLUDED.updated_at",
          [record.connectorId, value]
        );
        return;
      }
      (await sqlite()).execDynamicSqlAcknowledged(
        `INSERT INTO connector_installs(connector_id, record_json, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(connector_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`,
        [record.connectorId, value]
      );
    },
    dataDir,
    async deactivate(connectorId) {
      const pg = await postgres();
      if (pg.isPostgresStorageBackend()) {
        await pg.postgresQuery("DELETE FROM connector_installs WHERE connector_id = $1", [connectorId]);
        return;
      }
      (await sqlite()).execDynamicSqlAcknowledged("DELETE FROM connector_installs WHERE connector_id = ?", [
        connectorId,
      ]);
    },
    async getActive(connectorId) {
      const pg = await postgres();
      if (pg.isPostgresStorageBackend()) {
        return parse(
          (
            await pg.postgresQuery<InstallRow>("SELECT record_json FROM connector_installs WHERE connector_id = $1", [
              connectorId,
            ])
          ).rows[0]
        );
      }
      const db = await sqlite();
      return parse(
        [
          ...db.iterateDynamicSqlAcknowledged<InstallRow>(
            "SELECT record_json FROM connector_installs WHERE connector_id = ?",
            [connectorId]
          ),
        ].at(0)
      );
    },
    async getCatalogHighWater() {
      const pg = await postgres();
      if (pg.isPostgresStorageBackend()) {
        return (
          (
            await pg.postgresQuery<HighWaterRow>(
              "SELECT catalog_high_water FROM connector_install_catalog_state WHERE id = 1"
            )
          ).rows[0]?.catalog_high_water ?? null
        );
      }
      const db = await sqlite();
      return (
        [
          ...db.iterateDynamicSqlAcknowledged<HighWaterRow>(
            "SELECT catalog_high_water FROM connector_install_catalog_state WHERE id = 1"
          ),
        ].at(0)?.catalog_high_water ?? null
      );
    },
    async listActive() {
      const pg = await postgres();
      if (pg.isPostgresStorageBackend()) {
        return (
          await pg.postgresQuery<InstallRow>("SELECT record_json FROM connector_installs ORDER BY connector_id")
        ).rows
          .map(parse)
          .filter((row): row is ConnectorInstallRecord => row !== null);
      }
      const db = await sqlite();
      return [
        ...db.iterateDynamicSqlAcknowledged<InstallRow>(
          "SELECT record_json FROM connector_installs ORDER BY connector_id"
        ),
      ]
        .map(parse)
        .filter((row): row is ConnectorInstallRecord => row !== null);
    },
    async setCatalogHighWater(value) {
      const pg = await postgres();
      if (pg.isPostgresStorageBackend()) {
        await pg.postgresQuery(
          "INSERT INTO connector_install_catalog_state(id, catalog_high_water) VALUES (1, $1) ON CONFLICT(id) DO UPDATE SET catalog_high_water = EXCLUDED.catalog_high_water",
          [value]
        );
        return;
      }
      (await sqlite()).execDynamicSqlAcknowledged(
        "INSERT INTO connector_install_catalog_state(id, catalog_high_water) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET catalog_high_water = excluded.catalog_high_water",
        [value]
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalManifestKey(manifest: Record<string, unknown>): string | null {
  const connectorKey = manifest.connector_key;
  const connectorId = manifest.connector_id;
  let raw: string | null = null;
  if (typeof connectorKey === "string") {
    raw = connectorKey;
  } else if (typeof connectorId === "string") {
    raw = connectorId;
  }
  return raw ? (canonicalConnectorKey(raw) ?? raw) : null;
}

function assertNoSymlinkComponents(path: string): void {
  let current: string = sep;
  for (const part of resolve(path).slice(sep.length).split(sep)) {
    if (!part) {
      continue;
    }
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Connector install path contains a symbolic-link component.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function removePublishedRootSafely(root: string, dataDir: string, connectorId: string, digest: string): void {
  const expectedRoot = resolve(dataDir, "connectors", connectorId, digest);
  if (resolve(root) !== expectedRoot) {
    return;
  }
  try {
    assertNoSymlinkComponents(root);
    rmSync(root, { force: true, recursive: true });
  } catch {
    // Never follow a path that became symlinked while compensating a failed install.
  }
}

function assertStoredRecordMetadata(active: ConnectorInstallRecord): void {
  if (
    !(CONNECTOR_ID.test(active.connectorId) && DIGEST.test(active.digest) && DIGEST.test(active.configDigest)) ||
    active.registry !== "ghcr.io" ||
    active.repository !== `pdp-connect/connector/${active.connectorId}` ||
    active.manifestPath !== "profile/collection-profile.json" ||
    active.entrypointPath !== "dist/collection-profile.mjs" ||
    active.provenancePath !== "provenance.json"
  ) {
    throw new Error("Active connector record is invalid.");
  }
}

function assertStoredFileHashes(root: string, active: ConnectorInstallRecord): void {
  const checks: readonly [string, string][] = [
    [active.manifestPath, active.manifestSha256],
    [active.entrypointPath, active.entrypointSha256],
    [active.provenancePath, active.provenanceSha256],
  ];
  for (const [path, expected] of checks) {
    const file = confinedFile(root, path);
    if (!(file && DIGEST.test(expected)) || sha256(file) !== expected) {
      throw new Error("Active connector bytes failed integrity verification.");
    }
  }
}

function readLockOwner(lockDir: string): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(join(lockDir, "pid"), "utf8").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    // A process may have created the directory but not written its pid yet.
    return null;
  }
}

function reclaimStaleLock(lockDir: string, ownerPid: number): boolean {
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (probeError) {
    if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") {
      throw probeError;
    }
    const staleLockDir = `${lockDir}.stale.${ownerPid}.${Date.now()}`;
    try {
      renameSync(lockDir, staleLockDir);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw renameError;
    }
    rmSync(staleLockDir, { force: true, recursive: true });
    return true;
  }
}

function acquireDirectoryLock(dataDir: string, lockName: string, busyMessage: string): () => void {
  assertNoSymlinkComponents(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const lockDir = join(dataDir, lockName);
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const ownerPid = readLockOwner(lockDir);
      if (ownerPid === null) {
        throw new Error(busyMessage, { cause: error });
      }
      if (reclaimStaleLock(lockDir, ownerPid)) {
        continue;
      }
      throw new Error(busyMessage, { cause: error });
    }
  }
  writeFileSync(join(lockDir, "pid"), `${String(process.pid)}\n`, { mode: 0o600 });
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    rmSync(lockDir, { force: true, recursive: true });
  };
}

function acquireInstallLock(dataDir: string): () => void {
  return acquireDirectoryLock(dataDir, ".connector-install.lock", "Another connector installation is in progress.");
}

function acquireCatalogStateLock(dataDir: string): () => void {
  return acquireDirectoryLock(dataDir, ".connector-catalog.lock", "Another connector catalog refresh is in progress.");
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function confinedFile(root: string, path: string): string | null {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  try {
    const realRoot = realpathSync(root);
    const candidate = resolve(realRoot, path);
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}/`)) {
      if (sep === "/" || !candidate.startsWith(`${realRoot}${sep}`)) {
        throw new Error("Path escapes its root.");
      }
    }
    let current = realRoot;
    for (const part of path.split("/")) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return null;
      }
      if (current !== candidate && !stat.isDirectory()) {
        return null;
      }
    }
    if (!lstatSync(candidate).isFile()) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export async function inspectActiveConnector(
  store: ConnectorInstallStore,
  connectorId: string
): Promise<ActiveConnectorInspection> {
  let active: ConnectorInstallRecord | null;
  try {
    active = await store.getActive(connectorId);
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: "invalid",
    };
  }
  if (!active) {
    return { status: "none" };
  }
  if (active.connectorId !== connectorId) {
    return { reason: "active connector id mismatch", status: "invalid" };
  }
  try {
    const verified = verifyStoredRecord(active.root, active, store.dataDir);
    const path = confinedFile(verified.root, verified.entrypointPath);
    if (!path) {
      return { reason: "active entrypoint path is invalid", status: "invalid" };
    }
    return { path, record: verified, status: "active" };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: "invalid",
    };
  }
}

/**
 * Every active install whose recorded bytes still verify, in store order.
 * A record that fails verification is reported, never returned, so a caller
 * that discovers profiles by manifest cannot read an unverified one.
 */
export async function listVerifiedActiveConnectors(store: ConnectorInstallStore): Promise<{
  readonly invalid: readonly { readonly connectorId: string; readonly reason: string }[];
  readonly verified: readonly ConnectorInstallRecord[];
}> {
  const invalid: { connectorId: string; reason: string }[] = [];
  const verified: ConnectorInstallRecord[] = [];
  for (const record of await store.listActive()) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential keeps store order and bounds concurrent file hashing.
    const inspected = await inspectActiveConnector(store, record.connectorId);
    if (inspected.status === "active") {
      verified.push(inspected.record);
    } else if (inspected.status === "invalid") {
      invalid.push({ connectorId: record.connectorId, reason: inspected.reason });
    }
  }
  return { invalid, verified };
}

/** Returns a runnable installed entrypoint only after every recorded byte check passes. */
export async function resolveActiveConnectorPath(
  store: ConnectorInstallStore,
  connectorId: string
): Promise<string | null> {
  const inspected = await inspectActiveConnector(store, connectorId);
  return inspected.status === "active" ? inspected.path : null;
}

function verifyStoredRecord(root: string, active: ConnectorInstallRecord, dataDir?: string): ConnectorInstallRecord {
  assertStoredRecordMetadata(active);
  const normalizedRoot = resolve(root);
  const configuredDataDir = resolve(dataDir ?? process.env.PDPP_DATA_DIR ?? join(process.cwd(), "data"));
  const expectedRoot = resolve(configuredDataDir, "connectors", active.connectorId, active.digest);
  if (normalizedRoot !== expectedRoot || resolve(active.root) !== normalizedRoot) {
    throw new Error("Active connector root is outside the connector data directory.");
  }
  assertNoSymlinkComponents(normalizedRoot);
  assertStoredFileHashes(normalizedRoot, active);
  const manifestFile = confinedFile(normalizedRoot, active.manifestPath);
  if (!manifestFile) {
    throw new Error("Active connector manifest path is invalid.");
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  const manifestKey = canonicalManifestKey(manifest);
  if (manifestKey !== active.connectorId) {
    throw new Error("Active connector manifest identity does not match its record.");
  }
  return { ...active, manifest, root: normalizedRoot };
}

function assertCatalogEntry(entry: ConnectorCatalogEntry, connectorId: string, digest?: string): void {
  if (
    !(CONNECTOR_ID.test(connectorId) && CONNECTOR_ID.test(entry.connector_key)) ||
    entry.connector_id !== connectorId ||
    entry.connector_key !== connectorId
  ) {
    throw new Error("Catalog connector identity is invalid.");
  }
  if (
    entry.digest !== digest ||
    !DIGEST.test(entry.digest) ||
    (entry.config_digest !== undefined && !DIGEST.test(entry.config_digest))
  ) {
    throw new Error("Requested connector digest is not a verified catalog target.");
  }
}

function readVerifiedRecord(root: string, entry: ConnectorCatalogEntry): ConnectorInstallRecord {
  const manifestPath = "profile/collection-profile.json";
  const entrypointPath = "dist/collection-profile.mjs";
  const provenancePath = "provenance.json";
  const configPath = confinedFile(root, "config.json");
  if (configPath && lstatSync(configPath).size > MAX_CONFIG_BYTES) {
    throw new Error("Connector OCI config exceeds the 1 MiB RI limit.");
  }
  const manifestFile = confinedFile(root, manifestPath);
  const entrypointFile = confinedFile(root, entrypointPath);
  const provenanceFile = confinedFile(root, provenancePath);
  if (!(manifestFile && entrypointFile && provenanceFile)) {
    throw new Error("Verified connector layout is incomplete.");
  }
  if (lstatSync(manifestFile).size > MAX_CONFIG_BYTES) {
    throw new Error("Connector profile exceeds the 1 MiB RI limit.");
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Connector profile is invalid.");
  }
  const manifestRecord = manifest as Record<string, unknown>;
  const manifestKey = canonicalManifestKey(manifestRecord);
  if (manifestKey !== entry.connector_key) {
    throw new Error("Connector profile identity does not match the catalog target.");
  }
  const configDigest = entry.config_digest;
  if (typeof configDigest !== "string" || !DIGEST.test(configDigest)) {
    throw new Error("Verified OCI artifact did not expose a config digest.");
  }
  return {
    activatedAt: new Date().toISOString(),
    bindings: entry.bindings ?? {},
    configDigest,
    connectorId: entry.connector_id,
    digest: entry.digest,
    entrypointPath,
    entrypointSha256: sha256(entrypointFile),
    manifest: manifestRecord,
    manifestPath,
    manifestSha256: sha256(manifestFile),
    provenancePath,
    provenanceSha256: sha256(provenanceFile),
    registry: "ghcr.io",
    repository: `pdp-connect/connector/${entry.connector_key}`,
    root,
    tier: entry.tier ?? null,
    version: entry.version ?? null,
  };
}

async function reuseExistingInstall(
  root: string,
  entry: ConnectorCatalogEntry,
  existing: ConnectorInstallRecord | null,
  previousActive: ConnectorInstallRecord | null,
  dataDir: string,
  registerManifest: (manifest: Record<string, unknown>) => Promise<unknown>,
  store: ConnectorInstallStore
): Promise<ConnectorInstallRecord> {
  if (existing) {
    if (
      existing.digest !== entry.digest ||
      (entry.config_digest !== undefined && existing.configDigest !== entry.config_digest) ||
      resolve(existing.root) !== resolve(root)
    ) {
      throw new Error("Connector digest root already exists without a matching active record.");
    }
  }
  const reusable = existing ?? { ...readVerifiedRecord(root, entry), root };
  const verified = verifyStoredRecord(root, reusable, dataDir);
  await store.activate(verified);
  try {
    await registerManifest(verified.manifest);
  } catch (error) {
    if (previousActive) {
      await store.activate(previousActive);
    } else {
      await store.deactivate(entry.connector_id);
    }
    throw error;
  }
  return verified;
}

// biome-ignore lint/suspicious/noConfusingVoidType: Test fixtures may use synchronous installers.
type InstallArtifact = (root: string, entry: ConnectorCatalogEntry) => Promise<string | void> | string | void;

async function installStagedEntry(options: {
  readonly connectorId: string;
  readonly dataDir: string;
  readonly entry: ConnectorCatalogEntry;
  readonly existing: ConnectorInstallRecord | null;
  readonly installArtifact: InstallArtifact;
  readonly registerManifest: (manifest: Record<string, unknown>) => Promise<unknown>;
  readonly root: string;
  readonly store: ConnectorInstallStore;
}): Promise<ConnectorInstallRecord> {
  const transaction = mkdtempSync(join(dirname(options.root), `.${options.entry.digest.replace(":", "-")}-install-`));
  const staged = join(transaction, "next");
  let published = false;
  try {
    const discoveredConfigDigest = await options.installArtifact(staged, options.entry);
    const verifiedEntry = discoveredConfigDigest
      ? { ...options.entry, config_digest: discoveredConfigDigest }
      : options.entry;
    assertCatalogEntry(verifiedEntry, options.connectorId, options.entry.digest);
    const record = readVerifiedRecord(staged, verifiedEntry);
    renameSync(staged, options.root);
    published = true;
    const active = { ...record, root: options.root };
    const verifiedActive = verifyStoredRecord(options.root, active, options.dataDir);
    await options.store.activate(verifiedActive);
    await options.registerManifest(verifiedActive.manifest);
    return verifiedActive;
  } catch (error) {
    if (published) {
      if (options.existing) {
        await options.store.activate(options.existing);
      } else {
        await options.store.deactivate(options.connectorId);
      }
      removePublishedRootSafely(options.root, options.dataDir, options.connectorId, options.entry.digest);
    }
    throw error;
  } finally {
    rmSync(transaction, { force: true, recursive: true });
  }
}

export interface ConnectorInstallService {
  catalog: () => Promise<readonly ConnectorCatalogEntry[]>;
  install: (connectorId: string, digest: string) => Promise<ConnectorInstallRecord>;
  resolveManifestFromCatalog?: (connectorId: string) => Promise<Record<string, unknown> | null>;
  addLocalSource?: (sourcePath: string) => Promise<LocalConnectorSourceRecord>;
  listLocalSources?: () => Promise<readonly LocalConnectorSourceRecord[]>;
  reloadLocalSource?: (sourceId: string) => Promise<LocalConnectorSourceRecord>;
  removeLocalSource?: (sourceId: string) => Promise<void>;
  selectLocalSource?: (connectorKey: string, sourceId: string | null) => Promise<void>;
  status: () => Promise<readonly ConnectorInstallRecord[]>;
  update: (connectorId: string) => Promise<ConnectorInstallRecord>;
}

export function createConnectorInstallService(options: {
  readonly dataDir?: string;
  readonly store?: ConnectorInstallStore;
  readonly catalogLoader?: () => Promise<readonly ConnectorCatalogEntry[] | ConnectorCatalogSnapshot>;
  /** Test seam; production always delegates OCI verification to the pinned core. */
  readonly installArtifact?: InstallArtifact;
  readonly localSourceStore?: LocalConnectorSourceStore;
  readonly registerManifest: (manifest: Record<string, unknown>) => Promise<unknown>;
}): ConnectorInstallService {
  const dataDir =
    options.dataDir ||
    process.env.PDPP_CONNECTOR_PRELOAD_DIR ||
    process.env.PDPP_DATA_DIR ||
    join(process.cwd(), "data");
  const store =
    options.store ||
    (process.env.PDPP_CONNECTOR_PRELOAD_DIR ? createFileConnectorInstallStore(dataDir) : createConnectorInstallStore());
  const localSourceStore = options.localSourceStore || createFileLocalConnectorSourceStore(dataDir);
  let catalogRefresh: Promise<readonly ConnectorCatalogEntry[]> | undefined;
  const loadCatalog = async (): Promise<readonly ConnectorCatalogEntry[]> => {
    const release = acquireCatalogStateLock(dataDir);
    try {
      const previousHighWater = await store.getCatalogHighWater();
      const loaded = options.catalogLoader
        ? await options.catalogLoader()
        : await loadCatalogFromPinnedCore(previousHighWater);
      const snapshot: ConnectorCatalogSnapshot = Array.isArray(loaded)
        ? { entries: loaded as readonly ConnectorCatalogEntry[] }
        : (loaded as ConnectorCatalogSnapshot);
      if (!Array.isArray(snapshot.entries)) {
        throw new Error("Verified connector catalog has an invalid entry list.");
      }
      for (const entry of snapshot.entries) {
        assertCatalogEntry(entry, entry.connector_id, entry.digest);
      }
      const highWater =
        snapshot.generatedAt ??
        snapshot.entries
          .map((entry) => entry.digest)
          .sort()
          .join(",");
      if (snapshot.generatedAt && !Number.isFinite(Date.parse(snapshot.generatedAt))) {
        throw new Error("Verified connector catalog has an invalid generated_at timestamp.");
      }
      if (
        snapshot.generatedAt &&
        previousHighWater &&
        Number.isFinite(Date.parse(previousHighWater)) &&
        Date.parse(snapshot.generatedAt) < Date.parse(previousHighWater)
      ) {
        throw new Error("Catalog rollback refused by high-water mark.");
      }
      await store.setCatalogHighWater(highWater);
      return snapshot.entries;
    } finally {
      release();
    }
  };
  const catalog = async (): Promise<readonly ConnectorCatalogEntry[]> => {
    const refresh = catalogRefresh ?? loadCatalog();
    catalogRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (catalogRefresh === refresh) {
        catalogRefresh = undefined;
      }
    }
  };
  const installEntry = async (connectorId: string, entry: ConnectorCatalogEntry): Promise<ConnectorInstallRecord> => {
    const release = acquireInstallLock(dataDir);
    try {
      const root = join(dataDir, "connectors", connectorId, entry.digest);
      const existing = await store.getActive(connectorId);
      if (existsSync(root)) {
        if (existing && existing.digest === entry.digest && resolve(existing.root) === resolve(root)) {
          const inspected = await inspectActiveConnector(store, connectorId);
          if (inspected.status === "active") {
            return await reuseExistingInstall(
              root,
              entry,
              existing,
              existing,
              dataDir,
              options.registerManifest,
              store
            );
          }
          removePublishedRootSafely(root, dataDir, connectorId, entry.digest);
          if (existsSync(root)) {
            throw new Error("Connector digest root already exists without a matching active record.");
          }
        } else if (existing) {
          return await reuseExistingInstall(root, entry, null, existing, dataDir, options.registerManifest, store);
        } else {
          // A crash can leave the published directory between rename and the
          // active-record commit. Do not delete a valid retained root only
          // because its active record is missing.
          try {
            readVerifiedRecord(root, entry);
            throw new Error("Connector digest root already exists without a matching active record.");
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Connector digest root already exists without a matching active record."
            ) {
              throw error;
            }
          }
          removePublishedRootSafely(root, dataDir, connectorId, entry.digest);
          if (existsSync(root)) {
            throw new Error("Connector digest root already exists without a matching active record.");
          }
        }
      }
      assertNoSymlinkComponents(dataDir);
      const connectorsDir = join(dataDir, "connectors");
      assertNoSymlinkComponents(connectorsDir);
      mkdirSync(connectorsDir, { recursive: true });
      const connectorDir = join(connectorsDir, connectorId);
      assertNoSymlinkComponents(connectorDir);
      mkdirSync(connectorDir, { recursive: true });
      assertNoSymlinkComponents(connectorDir);
      return await installStagedEntry({
        connectorId,
        dataDir,
        entry,
        existing,
        installArtifact: options.installArtifact ?? installPinnedArtifact,
        registerManifest: options.registerManifest,
        root,
        store,
      });
    } finally {
      release();
    }
  };
  const install = async (connectorId: string, digest: string): Promise<ConnectorInstallRecord> => {
    const entry = (await catalog()).find(
      (candidate) => candidate.connector_id === connectorId && candidate.digest === digest
    );
    if (!entry) {
      throw new Error("Connector digest is not present in the verified catalog.");
    }
    assertCatalogEntry(entry, connectorId, digest);
    return installEntry(connectorId, entry);
  };
  const resolveManifestFromCatalog = async (connectorId: string): Promise<Record<string, unknown> | null> => {
    const entry = (await catalog()).find(
      (candidate) => candidate.connector_id === connectorId && candidate.latest === true
    );
    if (!entry) {
      return null;
    }
    const core = await loadPinnedCore();
    if (!core.fetchResolvedArtifact) {
      throw new Error("Pinned connector installer core does not expose fetchResolvedArtifact.");
    }
    const identityResolver = ({ registry, repository }: { registry: string; repository: string }) => {
      if (registry === "ghcr.io" && repository === `pdp-connect/connector/${entry.connector_key}`) {
        return core.DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY;
      }
      return null;
    };
    const limitedTransport = createConfigLimitedFetch(fetch, entry.digest);
    const artifact = await core.fetchResolvedArtifact(
      { doc: {}, mode: "locked" },
      {
        artifactKind: "pdpp-collection-profile",
        connectorId: entry.connector_id,
        connectorKey: entry.connector_key,
        entrypointPath: "dist/collection-profile.mjs",
        manifestPath: "profile/collection-profile.json",
        oci: {
          digest: entry.digest,
          registry: "ghcr.io",
          repository: `pdp-connect/connector/${entry.connector_key}`,
        },
        provenancePath: "provenance.json",
        version: entry.version ?? entry.digest,
      },
      {
        fetchImpl: limitedTransport.fetchImpl,
        ociCertificateIdentityResolver: identityResolver,
      }
    );
    const manifest = isRecord(artifact) && isRecord(artifact.manifest) ? artifact.manifest : null;
    if (!manifest || canonicalManifestKey(manifest) !== entry.connector_key) {
      throw new Error("Signed connector manifest identity does not match the catalog entry.");
    }
    return manifest;
  };
  return {
    addLocalSource: (sourcePath) => localSourceStore.add(sourcePath),
    catalog,
    install,
    resolveManifestFromCatalog,
    listLocalSources: () => localSourceStore.list(),
    reloadLocalSource: (sourceId) => localSourceStore.reload(sourceId),
    removeLocalSource: (sourceId) => localSourceStore.remove(sourceId),
    selectLocalSource: (connectorKey, sourceId) => localSourceStore.select(connectorKey, sourceId),
    status: async () => (await listVerifiedActiveConnectors(store)).verified,
    async update(connectorId) {
      const entries = await catalog();
      const candidates = entries.filter((entry) => entry.connector_id === connectorId);
      const candidate = candidates.find((entry) => entry.latest === true);
      if (!candidate) {
        throw new Error("Connector has no verified update target.");
      }
      assertCatalogEntry(candidate, connectorId, candidate.digest);
      return installEntry(connectorId, candidate);
    },
  };
}

async function loadPinnedCore(): Promise<InstallerCore> {
  return (await import(CORE_MODULE)) as InstallerCore;
}

async function loadCatalogFromPinnedCore(lastAcceptedGeneratedAt: string | null): Promise<ConnectorCatalogSnapshot> {
  const core = await loadPinnedCore();
  if (!core.fetchCatalog) {
    throw new Error("Pinned connector installer core does not expose fetchCatalog.");
  }
  const value = (await core.fetchCatalog({
    identity: core.DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
    registry: "ghcr.io",
    ...(lastAcceptedGeneratedAt ? { lastAcceptedGeneratedAt } : {}),
  })) as { catalog?: { generated_at?: string; connectors?: unknown[] } };
  const connectors = value.catalog?.connectors;
  if (!Array.isArray(connectors)) {
    throw new Error("Verified connector catalog has an invalid shape.");
  }
  const entries = connectors.flatMap(normalizeCatalogConnector);
  const generatedAt = value.catalog?.generated_at;
  return generatedAt ? { entries, generatedAt } : { entries };
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function normalizeCatalogConnector(connector: unknown): ConnectorCatalogEntry[] {
  if (
    !isRecord(connector) ||
    typeof connector.connector_key !== "string" ||
    typeof connector.connector_id !== "string"
  ) {
    throw new Error("Verified connector catalog has an invalid connector entry.");
  }
  const connectorKey = connector.connector_key;
  const catalogConnectorId = connector.connector_id;
  const latest = isRecord(connector.latest) ? connector.latest : null;
  const versions = Array.isArray(connector.versions) ? connector.versions : [];
  const runtimeRequirements = isRecord(connector.runtime_requirements) ? connector.runtime_requirements : null;
  const bindings =
    runtimeRequirements && isRecord(runtimeRequirements.bindings)
      ? (runtimeRequirements.bindings as Readonly<Record<string, unknown>>)
      : {};
  const setup = isRecord(connector.setup) ? connector.setup : null;
  const displayName = optionalString(connector, "display_name");
  const tier = optionalString(connector, "tier");
  return versions.map((version): ConnectorCatalogEntry => {
    if (!isRecord(version) || typeof version.version !== "string" || typeof version.digest !== "string") {
      throw new Error("Verified connector catalog has an invalid version entry.");
    }
    const latestVersion = latest?.digest === version.digest;
    const publishedAt = latestVersion && latest ? optionalString(latest, "published_at") : null;
    return {
      bindings,
      catalog_connector_id: catalogConnectorId,
      connector_id: connectorKey,
      connector_key: connectorKey,
      digest: version.digest,
      latest: latestVersion,
      setup_modality: setup ? optionalString(setup, "modality") : null,
      version: version.version,
      ...(displayName ? { display_name: displayName } : {}),
      ...(publishedAt ? { published_at: publishedAt } : {}),
      ...(tier ? { tier } : {}),
    };
  });
}

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Response | Promise<Response>;

function extractManifestLayerDigests(buffer: Buffer): {
  readonly configDigest: string | null;
  readonly profileDigest: string | null;
} | null {
  try {
    const manifest = JSON.parse(buffer.toString("utf8")) as {
      config?: { digest?: unknown };
      layers?: unknown;
    };
    const configDigest = typeof manifest.config?.digest === "string" ? manifest.config.digest : null;
    let profileDigest: string | null = null;
    if (Array.isArray(manifest.layers)) {
      const profileLayer = (manifest.layers as Array<{ digest?: unknown; mediaType?: unknown }>).find(
        (layer) => layer.mediaType === "application/vnd.pdpp.connector.profile.v1+json"
      );
      profileDigest = typeof profileLayer?.digest === "string" ? profileLayer.digest : null;
    }
    return { configDigest, profileDigest };
  } catch {
    return null;
  }
}

export function createConfigLimitedFetch(baseFetch: FetchLike, expectedManifestDigest?: string): {
  readonly fetchImpl: typeof fetch;
  readonly configDigest: () => string | null;
} {
  let discoveredConfigDigest: string | null = null;
  let discoveredProfileDigest: string | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    let requestUrl: string;
    if (typeof input === "string") {
      requestUrl = input;
    } else if (input instanceof URL) {
      requestUrl = input.href;
    } else {
      requestUrl = input.url;
    }
    const parsedUrl = new URL(requestUrl);
    const manifestMatch = MANIFEST_REQUEST.exec(parsedUrl.pathname);
    const isExpectedManifest =
      manifestMatch !== null && (!expectedManifestDigest || manifestMatch[1] === expectedManifestDigest);
    const blobMatch = BLOB_REQUEST.exec(parsedUrl.pathname);
    const isBoundedBlob =
      blobMatch?.[1] !== undefined &&
      (blobMatch[1] === discoveredConfigDigest || blobMatch[1] === discoveredProfileDigest);
    if (isBoundedBlob) {
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isSafeInteger(contentLength) && contentLength > MAX_CONFIG_BYTES) {
        throw new Error("Connector OCI config exceeds the 1 MiB RI limit.");
      }
    }
    const originalArrayBuffer = response.arrayBuffer.bind(response);
    let bufferPromise: Promise<Buffer> | null = null;
    const readBuffer = async (): Promise<Buffer> => {
      if (!bufferPromise) {
        bufferPromise = originalArrayBuffer().then((arrayBuffer) => {
          const buffer = Buffer.from(arrayBuffer);
          if (isBoundedBlob && buffer.length > MAX_CONFIG_BYTES) {
            throw new Error("Connector OCI config or profile exceeds the 1 MiB RI limit.");
          }
          if (isExpectedManifest) {
            const layerDigests = extractManifestLayerDigests(buffer);
            // An unrelated or malformed response at a manifest-shaped path
            // must not erase a digest already read from the OCI manifest.
            if (layerDigests?.configDigest) {
              discoveredConfigDigest = layerDigests.configDigest;
              if (layerDigests.profileDigest) {
                discoveredProfileDigest = layerDigests.profileDigest;
              }
            }
          }
          return buffer;
        });
      }
      return bufferPromise;
    };
    Object.defineProperties(response, {
      arrayBuffer: {
        configurable: true,
        value: async () => {
          const buffer = await readBuffer();
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
      },
      json: {
        configurable: true,
        value: async () => JSON.parse((await readBuffer()).toString("utf8")),
      },
      text: {
        configurable: true,
        value: async () => (await readBuffer()).toString("utf8"),
      },
    });
    return response;
  };
  return { configDigest: () => discoveredConfigDigest, fetchImpl };
}

async function installPinnedArtifact(root: string, entry: ConnectorCatalogEntry): Promise<string> {
  const core = await loadPinnedCore();
  if (!core.fetchResolvedArtifact) {
    throw new Error("Pinned connector installer core does not expose fetchResolvedArtifact.");
  }
  const identityResolver = ({ registry, repository }: { registry: string; repository: string }) => {
    if (registry === "ghcr.io" && repository === `pdp-connect/connector/${entry.connector_key}`) {
      return core.DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY;
    }
    return null;
  };
  const preflightTransport = createConfigLimitedFetch(fetch, entry.digest);
  const preflight = await core.fetchResolvedArtifact(
    { doc: {}, mode: "locked" },
    {
      artifactKind: "pdpp-collection-profile",
      connectorId: entry.connector_id,
      connectorKey: entry.connector_key,
      entrypointPath: "dist/collection-profile.mjs",
      manifestPath: "profile/collection-profile.json",
      oci: {
        ...(entry.config_digest ? { configDigest: entry.config_digest } : {}),
        digest: entry.digest,
        registry: "ghcr.io",
        repository: `pdp-connect/connector/${entry.connector_key}`,
      },
      provenancePath: "provenance.json",
      version: entry.version ?? entry.digest,
    },
    {
      fetchImpl: preflightTransport.fetchImpl,
      ociCertificateIdentityResolver: identityResolver,
    }
  );
  const preflightOci = isRecord(preflight) && isRecord(preflight.oci) ? preflight.oci : null;
  const configDigest = preflightOci && typeof preflightOci.configDigest === "string" ? preflightOci.configDigest : null;
  if (!(configDigest && DIGEST.test(configDigest)) || (entry.config_digest && entry.config_digest !== configDigest)) {
    throw new Error(
      `OCI preflight config digest does not match the verified install identity (catalog=${entry.config_digest ?? "none"}, manifest=${configDigest ?? "none"}).`
    );
  }
  const limitedTransport = createConfigLimitedFetch(fetch, entry.digest);
  await core.installFromLock({
    artifactCertificateIdentityResolver: () => null,
    fetchImpl: limitedTransport.fetchImpl,
    installRoot: root,
    layout: "source",
    lock: {
      connectors: [
        {
          artifactKind: "pdpp-collection-profile",
          connectorId: entry.connector_id,
          connectorKey: entry.connector_key,
          entrypointPath: "dist/collection-profile.mjs",
          manifestPath: "profile/collection-profile.json",
          oci: {
            configDigest,
            digest: entry.digest,
            registry: "ghcr.io",
            repository: `pdp-connect/connector/${entry.connector_key}`,
          },
          provenancePath: "provenance.json",
          version: entry.version ?? entry.digest,
        },
      ],
      lockVersion: "2.0",
    },
    maxConfigBytes: MAX_CONFIG_BYTES,
    ociCertificateIdentityResolver: ({ registry, repository }: { registry: string; repository: string }) =>
      registry === "ghcr.io" && repository === `pdp-connect/connector/${entry.connector_key}`
        ? core.DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY
        : null,
    source: { doc: {}, mode: "locked" },
  });
  const installedConfigDigest = limitedTransport.configDigest();
  if (!installedConfigDigest || installedConfigDigest !== configDigest) {
    throw new Error(
      `OCI install config digest was not confirmed by the transport (preflight=${configDigest}, manifest=${installedConfigDigest ?? "none"}).`
    );
  }
  normalizeCoreInstallLayout(root, entry.connector_id);
  return configDigest;
}

export function normalizeCoreInstallLayout(root: string, connectorId: string): void {
  const coreRoot = join(root, "collection-profiles", connectorId);
  for (const name of ["profile", "dist", "provenance.json", "source-declaration.json"]) {
    const source = join(coreRoot, name);
    if (!existsSync(source)) {
      throw new Error("Pinned installer core produced an incomplete collection-profile layout.");
    }
    renameSync(source, join(root, name));
  }
  for (const name of ["licenses", "assets"]) {
    const source = join(coreRoot, name);
    if (existsSync(source)) {
      renameSync(source, join(root, name));
    }
  }
  if (readdirSync(coreRoot).length !== 0) {
    throw new Error("Pinned installer core produced unexpected collection-profile files.");
  }
}
