// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export interface HistorySource { id: string; connector: string; name: string }
export function sourceName(sources: HistorySource[], id: string | null, connector?: string | null): string {
  return sources.find(source => source.id === id)?.name ?? sources.find(source => source.connector === (connector ?? id))?.name ?? "Data source";
}
