// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const URI_SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";
const TRAILING_SLASH = /\/$/u;

/** Preserve the first-party registry/key aliases; unrelated URLs remain exact identities. */
export function connectorIconIdentityKeys(connectorId: string): readonly string[] {
  const value = connectorId.trim();
  if (!value) {
    return [];
  }
  const keys = new Set([value]);
  let localKey: string | null = value;
  if (value.startsWith(REGISTRY_PREFIX)) {
    localKey = value.slice(REGISTRY_PREFIX.length).replace(TRAILING_SLASH, "");
  } else if (URI_SCHEME.test(value)) {
    localKey = null;
  }
  if (localKey !== null) {
    const canonical = localKey.replaceAll("_", "-");
    keys.add(canonical);
    keys.add(canonical.replaceAll("-", "_"));
  }
  return [...keys];
}
