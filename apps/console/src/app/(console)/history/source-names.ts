// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { appSourceName } from "../grants/app-access.ts";
export interface HistorySource {
  connector: string;
  id: string;
  name: string;
}
export function sourceName(sources: HistorySource[], id: string | null, connector?: string | null): string {
  const known = sources.find((source) => source.id === id)?.name;
  if (known) {
    return known;
  }
  const service = connector ?? sources.find((source) => source.connector === id)?.connector;
  if (service) {
    return appSourceName({ kind: "connector", id: service }) ?? "Data source";
  }
  return "Data source";
}
