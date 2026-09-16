// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONNECTOR_MANIFESTS_EXPORT = "@pdpp/polyfill-connectors/manifests";

type PackageExportResolver = (specifier: string) => string;

function resolvePackageExport(specifier: string): string {
  return import.meta.resolve(specifier);
}

/** Resolve the installed package's package-root manifests directory. */
export function resolveInstalledConnectorManifestsDir(
  resolveExport: PackageExportResolver = resolvePackageExport,
): string | null {
  try {
    const resolvedExport = resolveExport(CONNECTOR_MANIFESTS_EXPORT);
    const resolvedPath = resolvedExport.startsWith("file:") ? fileURLToPath(resolvedExport) : resolvedExport;
    return join(dirname(resolvedPath), "..", "manifests");
  } catch {
    return null;
  }
}
