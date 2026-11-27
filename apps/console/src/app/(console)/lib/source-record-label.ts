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

/**
 * The same name inside a sentence ("Not copied: your Steam friends."). A name that opens with a
 * common word ("Your Steam friends", or a plain "Friends") drops its capital; one that opens with
 * a service or product name ("Steam games") keeps it.
 */
export function sourceRecordLabelInSentence(name: string, streams: readonly StreamManifestEntry[] = []): string {
  const label = sourceRecordLabel(name, streams);
  const first = /^[A-Z][a-z]+/.exec(label)?.[0] ?? "";
  const declared = streams.some((stream) => stream.name === name && streamDisplayLabel(name, stream) !== name);
  return first && (first === "Your" || !declared) && !/^[A-Z][a-z]+[A-Z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}
