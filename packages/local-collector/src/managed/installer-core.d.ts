// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The installer core ships JavaScript without declarations. This names only
// the exports the collector calls; see collection-profiles.ts and
// scripts/pin-collection-profiles.ts.
declare module "@opendatalabs/data-connectors-tools/installer-core" {
  export const DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY: string;
  export function fetchCatalog(options: Record<string, unknown>): Promise<unknown>;
  export function fetchResolvedArtifact(
    source: Record<string, unknown>,
    entry: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<unknown>;
  export function installFromLock(options: Record<string, unknown>): Promise<unknown>;
}
