// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { humanizeFieldLabel, streamDisplayLabel, type StreamManifestEntry } from "@pdpp/display";
/** Owner record lists exclude the connector's copy bookkeeping. */
export function isOwnerRecordKind(name: string): boolean {
  return !["backup_inventory", "cache_inventory", "coverage_diagnostics"].includes(name);
}
export function sourceRecordLabel(name: string, streams: readonly StreamManifestEntry[] = []): string {
  const entry = streams.find(stream => stream.name === name);
  const declared = entry ? streamDisplayLabel(name, entry) : null;
  return declared && declared !== name ? declared : humanizeFieldLabel(name);
}
