// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { humanizeFieldLabel, type StreamManifestEntry, streamDisplayLabel } from "@pdpp/display";
/** Owner record lists exclude the connector's copy bookkeeping. */
const BOOKKEEPING_KINDS = new Set(["backup_inventory", "cache_inventory", "coverage_diagnostics", "config_inventory", "context_mode", "session_index"]);
export function isOwnerRecordKind(name: string, connectorId: string): boolean;
export function isOwnerRecordKind(name: string): boolean;
export function isOwnerRecordKind(name: string, connectorId?: string): boolean {
  return !BOOKKEEPING_KINDS.has(name) && !(connectorId === "claude-code" && ["attachments","usage","file_history","debug_artifacts","downloads","logs"].includes(name)) && !(connectorId === "codex" && ["history","memories"].includes(name));
}
export function sourceRecordLabel(name: string, streams: readonly StreamManifestEntry[] = []): string {
  const entry = streams.find((stream) => stream.name === name);
  const declared = entry ? streamDisplayLabel(name, entry) : null;
  return declared && declared !== name ? declared : humanizeFieldLabel(name);
}
