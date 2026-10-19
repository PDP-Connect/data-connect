// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData } from "./connector-runtime.ts";
import type { FingerprintCursor } from "./fingerprint-cursor.ts";

export type SourceClassification = "collect" | "collect_redacted" | "inventory_only" | "exclude" | "defer";

export interface KnownLocalStore {
  classification: SourceClassification;
  reason: string;
  relativePath: string;
  store: string;
  stream: string | null;
}

export interface InventoryRecord extends RecordData {
  classification: "inventory_only" | "defer";
  id: string;
  mtime_epoch: number | null;
  path_hash: string;
  reason: string;
  relative_path: string;
  size_bytes: number | null;
  store: string;
  type: "directory" | "file" | "missing" | "other";
}

export interface InventoryPlan {
  recordsByStream: Map<string, InventoryRecord[]>;
}

export declare function buildLocalSourceInventory(
  tool: string,
  sourceHome: string,
  stores: readonly KnownLocalStore[]
): Promise<InventoryPlan>;

export declare function listDirectoryInventory(input: {
  reason: string;
  relativeRoot: string;
  sourceHome: string;
  store: string;
  stream: string;
  tool: string;
}): Promise<InventoryRecord[]>;

export declare const INVENTORY_FINGERPRINT_EXCLUDE_KEYS: readonly ["mtime_epoch", "size_bytes"];
export declare function openInventoryFingerprintCursor(priorState: unknown): FingerprintCursor;
