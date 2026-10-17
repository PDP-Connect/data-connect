// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]*$/;
const JOURNAL_VERSION = 1;

export interface ConnectorUninstallRootMove {
  readonly original: string;
  readonly moved: string;
}

export interface ConnectorUninstallJournal<ActiveRecord = unknown> {
  readonly connectorId: string;
  readonly priorActiveRecord: ActiveRecord;
  readonly rootMoves: readonly ConnectorUninstallRootMove[];
  readonly version: typeof JOURNAL_VERSION;
}

export interface ConnectorUninstallJournalInput<ActiveRecord = unknown> {
  readonly connectorId: string;
  readonly priorActiveRecord: ActiveRecord;
  readonly rootMoves: readonly ConnectorUninstallRootMove[];
}

export interface ConnectorUninstallReconcileCallbacks<ActiveRecord = unknown> {
  readonly clearUninstalledMarker?: (connectorId: string) => Promise<void> | void;
  readonly getActive: (connectorId: string) => Promise<ActiveRecord | null> | ActiveRecord | null;
  readonly restoreActive: (record: ActiveRecord) => Promise<void> | void;
}

export type ConnectorUninstallReconcileResult =
  { readonly status: "no_journal" } | { readonly connectorId: string; readonly status: "restored" | "cleaned" };

function assertConnectorId(connectorId: string): void {
  if (!CONNECTOR_ID.test(connectorId)) throw new Error("Connector id is invalid.");
}

function connectorRoot(dataDir: string, connectorId: string): string {
  return resolve(dataDir, "connectors", connectorId);
}

function containsPath(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function assertContainedRootMove(dataDir: string, connectorId: string, move: ConnectorUninstallRootMove): void {
  const root = connectorRoot(dataDir, connectorId);
  if (!containsPath(root, move.original) || !containsPath(root, move.moved)) {
    throw new Error("Connector uninstall journal path is outside the connector root.");
  }
  if (resolve(move.original) === resolve(move.moved)) {
    throw new Error("Connector uninstall journal move must use distinct paths.");
  }
}

function assertRootMoves(dataDir: string, connectorId: string, rootMoves: readonly ConnectorUninstallRootMove[]): void {
  for (const move of rootMoves) {
    if (!move || typeof move.original !== "string" || typeof move.moved !== "string") {
      throw new Error("Connector uninstall journal root move is malformed.");
    }
    assertContainedRootMove(dataDir, connectorId, move);
  }
}

function journalDir(dataDir: string): string {
  return resolve(dataDir, "connector-uninstall-journals");
}

export function connectorUninstallJournalPath(dataDir: string, connectorId: string): string {
  assertConnectorId(connectorId);
  return join(journalDir(dataDir), `${connectorId}.journal`);
}

export function listConnectorUninstallJournalIds(dataDir: string): string[] {
  const dir = journalDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".journal"))
    .map((name) => {
      const connectorId = name.slice(0, -8);
      assertConnectorId(connectorId);
      return connectorId;
    })
    .sort();
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  try {
    fsyncPath(path);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function writeJsonDurably(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fsyncPath(temp);
  renameSync(temp, path);
  fsyncDirectory(dir);
}

function removeFileDurably(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
  fsyncDirectory(dirname(path));
}

function parseJournal<ActiveRecord>(dataDir: string, value: unknown): ConnectorUninstallJournal<ActiveRecord> {
  if (!value || typeof value !== "object") throw new Error("Connector uninstall journal is malformed.");
  const record = value as {
    connectorId?: unknown;
    priorActiveRecord?: unknown;
    rootMoves?: unknown;
    version?: unknown;
  };
  if (record.version !== JOURNAL_VERSION) throw new Error("Connector uninstall journal version is unsupported.");
  if (typeof record.connectorId !== "string") throw new Error("Connector uninstall journal connector id is missing.");
  assertConnectorId(record.connectorId);
  if (!Array.isArray(record.rootMoves)) throw new Error("Connector uninstall journal root moves are malformed.");
  assertRootMoves(dataDir, record.connectorId, record.rootMoves as ConnectorUninstallRootMove[]);
  if (record.priorActiveRecord === undefined) {
    throw new Error("Connector uninstall journal prior active record is missing.");
  }
  return {
    connectorId: record.connectorId,
    priorActiveRecord: record.priorActiveRecord as ActiveRecord,
    rootMoves: record.rootMoves as ConnectorUninstallRootMove[],
    version: JOURNAL_VERSION,
  };
}

export function writeConnectorUninstallJournal<ActiveRecord>(
  dataDir: string,
  input: ConnectorUninstallJournalInput<ActiveRecord>
): ConnectorUninstallJournal<ActiveRecord> {
  assertConnectorId(input.connectorId);
  assertRootMoves(dataDir, input.connectorId, input.rootMoves);
  const journal: ConnectorUninstallJournal<ActiveRecord> = {
    connectorId: input.connectorId,
    priorActiveRecord: input.priorActiveRecord,
    rootMoves: input.rootMoves.map((move) => ({
      moved: resolve(move.moved),
      original: resolve(move.original),
    })),
    version: JOURNAL_VERSION,
  };
  writeJsonDurably(connectorUninstallJournalPath(dataDir, input.connectorId), journal);
  return journal;
}

export function readConnectorUninstallJournal<ActiveRecord>(
  dataDir: string,
  connectorId: string
): ConnectorUninstallJournal<ActiveRecord> | null {
  const path = connectorUninstallJournalPath(dataDir, connectorId);
  if (!existsSync(path)) return null;
  return parseJournal<ActiveRecord>(dataDir, JSON.parse(readFileSync(path, "utf8")));
}

export function updateConnectorUninstallJournalRoots<ActiveRecord>(
  dataDir: string,
  connectorId: string,
  rootMoves: readonly ConnectorUninstallRootMove[]
): ConnectorUninstallJournal<ActiveRecord> {
  const existing = readConnectorUninstallJournal<ActiveRecord>(dataDir, connectorId);
  if (!existing) throw new Error("Connector uninstall journal does not exist.");
  return writeConnectorUninstallJournal(dataDir, {
    connectorId,
    priorActiveRecord: existing.priorActiveRecord,
    rootMoves,
  });
}

export function deleteConnectorUninstallJournal(dataDir: string, connectorId: string): void {
  removeFileDurably(connectorUninstallJournalPath(dataDir, connectorId));
}

function assertNotSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Connector uninstall journal path must not be a symbolic link.");
  }
}

function restoreMovedRoots(rootMoves: readonly ConnectorUninstallRootMove[]): void {
  for (const move of [...rootMoves].reverse()) {
    assertNotSymlink(move.moved);
    assertNotSymlink(move.original);
    if (existsSync(move.moved)) {
      if (existsSync(move.original)) throw new Error("Cannot restore connector root over an existing path.");
      mkdirSync(dirname(move.original), { recursive: true });
      renameSync(move.moved, move.original);
      fsyncDirectory(dirname(move.original));
    }
  }
}

function removeMovedAndOriginalRoots(rootMoves: readonly ConnectorUninstallRootMove[]): void {
  for (const move of rootMoves) {
    assertNotSymlink(move.moved);
    assertNotSymlink(move.original);
    rmSync(move.moved, { force: true, recursive: true });
    rmSync(move.original, { force: true, recursive: true });
    fsyncDirectory(dirname(move.moved));
    fsyncDirectory(dirname(move.original));
  }
}

export async function reconcileConnectorUninstallJournal<ActiveRecord>(
  dataDir: string,
  connectorId: string,
  callbacks: ConnectorUninstallReconcileCallbacks<ActiveRecord>
): Promise<ConnectorUninstallReconcileResult> {
  const journal = readConnectorUninstallJournal<ActiveRecord>(dataDir, connectorId);
  if (!journal) return { status: "no_journal" };
  const active = await callbacks.getActive(journal.connectorId);
  if (active) {
    await callbacks.restoreActive(journal.priorActiveRecord);
    restoreMovedRoots(journal.rootMoves);
    await callbacks.clearUninstalledMarker?.(journal.connectorId);
    deleteConnectorUninstallJournal(dataDir, journal.connectorId);
    return { connectorId: journal.connectorId, status: "restored" };
  }
  removeMovedAndOriginalRoots(journal.rootMoves);
  deleteConnectorUninstallJournal(dataDir, journal.connectorId);
  return { connectorId: journal.connectorId, status: "cleaned" };
}
