// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Replace internal terms in copy that this page shows outside Details. */
export function plainDataSourceCopy(value: string): string {
  return value
    .replaceAll(/\bsources?\b/gi, (word) => (word.toLowerCase().endsWith("s") ? "data sources" : "data source"))
    .replaceAll(/\bconnectors?\b/gi, (word) => (word.toLowerCase().endsWith("s") ? "data sources" : "data source"))
    .replaceAll(/\bconnections?\b/gi, (word) => (word.toLowerCase().endsWith("s") ? "data sources" : "data source"))
    .replaceAll(/\binstances?\b/gi, (word) => (word.toLowerCase().endsWith("s") ? "data sources" : "data source"))
    .replaceAll(/\bstreams?\b/gi, (word) => (word.toLowerCase().endsWith("s") ? "kinds of record" : "kind of record"))
    .replaceAll(/\bruns?\b/gi, (word) => (word.toLowerCase().endsWith("s") ? "syncs" : "sync"))
    .replaceAll(/\bcoverage\b/gi, "records")
    .replaceAll(/\bgrants?\b/gi, "app access")
    .replaceAll(/\bbearer\b/gi, "sign-in token")
    .replaceAll(/\bfleet\b/gi, "all data sources")
    .replaceAll(/\bprojection\b/gi, "summary")
    .replaceAll(/\bmanifest\b/gi, "data source settings")
    .replaceAll(/\breference server\b/gi, "data server");
}
