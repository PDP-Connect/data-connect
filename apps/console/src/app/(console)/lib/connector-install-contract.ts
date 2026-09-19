// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire types and boundary parsing for the owner connector-install API.
 *
 * The API's `bindings` values are intentionally retained as unknown records:
 * the snapshot defines the field but not its nested availability shape. The
 * presentation layer only treats an explicit `available: false` as a block.
 */

export type ConnectorInstallTier = "supported" | "preview" | "development";

export interface ConnectorInstallCatalogEntry {
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly catalog_connector_id?: string;
  readonly connector_id: string;
  readonly connector_key: string;
  readonly digest: string;
  readonly display_name?: string;
  readonly latest: boolean;
  readonly published_at?: string;
  readonly setup_modality?: string;
  readonly tier?: ConnectorInstallTier;
  readonly version: string;
}

export interface ConnectorInstallStatus {
  /** A package may be installed before its first activation/run. */
  readonly activated_at: string | null;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly config_digest: string;
  readonly connector_id: string;
  readonly digest: string;
  readonly entrypoint_sha256: string;
  readonly manifest_sha256: string;
  readonly provenance_sha256: string;
  readonly registry: string;
  readonly repository: string;
  readonly tier?: ConnectorInstallTier;
  readonly version: string;
}

export interface ConnectorLocalSource {
  readonly connector_id: string;
  readonly connector_key: string;
  readonly display_name: string;
  readonly entrypoint_path: string;
  readonly manifest_path: string;
  readonly provenance: "developer-local-unsigned";
  readonly selected: boolean;
  readonly source_id: string;
  readonly source_path: string;
  readonly updated_at: string;
  readonly version: string;
}

export interface ConnectorInstallCatalogResponse {
  readonly data: readonly ConnectorInstallCatalogEntry[];
  readonly object: "connector_install_catalog";
}

export interface ConnectorInstallStatusResponse {
  readonly data: readonly ConnectorInstallStatus[];
  readonly object: "connector_install_status";
}

export interface ConnectorInstallSnapshot {
  readonly catalog: readonly ConnectorInstallCatalogEntry[];
  readonly localSources?: readonly ConnectorLocalSource[];
  readonly status: readonly ConnectorInstallStatus[];
}

export class ConnectorInstallContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInstallContractError";
  }
}

type UnknownRecord = Record<string, unknown>;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function asRecord(value: unknown, context: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConnectorInstallContractError(`${context} must be an object.`);
  }
  return value as UnknownRecord;
}

function readString(record: UnknownRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConnectorInstallContractError(`${context}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readNullableString(record: UnknownRecord, key: string, context: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConnectorInstallContractError(`${context}.${key} must be a non-empty string or null.`);
  }
  return value.trim();
}

function readOptionalString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDigest(record: UnknownRecord, key: string, context: string): string {
  const value = readString(record, key, context);
  if (!SHA256_DIGEST_RE.test(value)) {
    throw new ConnectorInstallContractError(`${context}.${key} must be a lowercase sha256 digest.`);
  }
  return value;
}

function readTier(record: UnknownRecord, key: string, context: string): ConnectorInstallTier | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "supported" && value !== "preview" && value !== "development") {
    throw new ConnectorInstallContractError(`${context}.${key} has an unknown tier.`);
  }
  return value;
}

function readBindings(record: UnknownRecord, context: string): Readonly<Record<string, unknown>> {
  const value = record.bindings;
  if (value === undefined || value === null) {
    return {};
  }
  const bindings = asRecord(value, `${context}.bindings`);
  return bindings;
}

function readCatalogEntry(value: unknown, index: number): ConnectorInstallCatalogEntry {
  const context = `connector_install_catalog.data[${index}]`;
  const record = asRecord(value, context);
  if (typeof record.latest !== "boolean") {
    throw new ConnectorInstallContractError(`${context}.latest must be a boolean.`);
  }
  const catalogConnectorId = readOptionalString(record, "catalog_connector_id");
  const displayName = readOptionalString(record, "display_name");
  const publishedAt = readOptionalString(record, "published_at");
  const setupModality = readOptionalString(record, "setup_modality");
  const tier = readTier(record, "tier", context);
  return {
    bindings: readBindings(record, context),
    ...(catalogConnectorId ? { catalog_connector_id: catalogConnectorId } : {}),
    connector_id: readString(record, "connector_id", context),
    connector_key: readString(record, "connector_key", context),
    digest: readDigest(record, "digest", context),
    ...(displayName ? { display_name: displayName } : {}),
    latest: record.latest,
    ...(publishedAt ? { published_at: publishedAt } : {}),
    ...(setupModality ? { setup_modality: setupModality } : {}),
    ...(tier ? { tier } : {}),
    version: readString(record, "version", context),
  };
}

function readStatus(value: unknown, index: number): ConnectorInstallStatus {
  const context = `connector_install_status.data[${index}]`;
  const record = asRecord(value, context);
  const tier = readTier(record, "tier", context);
  return {
    activated_at: readNullableString(record, "activated_at", context),
    bindings: readBindings(record, context),
    config_digest: readDigest(record, "config_digest", context),
    connector_id: readString(record, "connector_id", context),
    digest: readDigest(record, "digest", context),
    entrypoint_sha256: readDigest(record, "entrypoint_sha256", context),
    manifest_sha256: readDigest(record, "manifest_sha256", context),
    provenance_sha256: readDigest(record, "provenance_sha256", context),
    registry: readString(record, "registry", context),
    repository: readString(record, "repository", context),
    ...(tier ? { tier } : {}),
    version: readString(record, "version", context),
  };
}

function readLocalSource(value: unknown, index: number): ConnectorLocalSource {
  const context = `connector_install_local_sources.data[${index}]`;
  const record = asRecord(value, context);
  const provenance = readString(record, "provenance", context);
  if (provenance !== "developer-local-unsigned") {
    throw new ConnectorInstallContractError(`${context}.provenance must identify an unsigned developer-local source.`);
  }
  if (typeof record.selected !== "boolean") {
    throw new ConnectorInstallContractError(`${context}.selected must be a boolean.`);
  }
  return {
    connector_id: readString(record, "connector_id", context),
    connector_key: readString(record, "connector_key", context),
    display_name: readString(record, "display_name", context),
    entrypoint_path: readString(record, "entrypoint_path", context),
    manifest_path: readString(record, "manifest_path", context),
    provenance: "developer-local-unsigned",
    selected: record.selected,
    source_id: readString(record, "source_id", context),
    source_path: readString(record, "source_path", context),
    updated_at: readString(record, "updated_at", context),
    version: readString(record, "version", context),
  };
}

function readData(payload: unknown, objectName: string): readonly unknown[] {
  const record = asRecord(payload, objectName);
  if (record.object !== objectName) {
    throw new ConnectorInstallContractError(`${objectName}.object must be '${objectName}'.`);
  }
  if (!Array.isArray(record.data)) {
    throw new ConnectorInstallContractError(`${objectName}.data must be an array.`);
  }
  return record.data;
}

export function parseConnectorInstallCatalogResponse(payload: unknown): ConnectorInstallCatalogResponse {
  const data = readData(payload, "connector_install_catalog").map(readCatalogEntry);
  return { data, object: "connector_install_catalog" };
}

export function parseConnectorInstallStatusResponse(payload: unknown): ConnectorInstallStatusResponse {
  const data = readData(payload, "connector_install_status").map(readStatus);
  return { data, object: "connector_install_status" };
}

export function parseConnectorLocalSourcesResponse(payload: unknown): readonly ConnectorLocalSource[] {
  return readData(payload, "connector_install_local_sources").map(readLocalSource);
}
