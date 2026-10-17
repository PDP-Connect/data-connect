// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const CONNECTOR_PACKAGE_NAME = "@pdpp/polyfill-connectors"
const CONNECTOR_PACKAGE_JSON = `${CONNECTOR_PACKAGE_NAME}/package.json`

type PackageExportResolver = (specifier: string) => string

const INSTALLED_PACKAGE_ROOT_CANDIDATES = [
  join(process.cwd(), "node_modules", CONNECTOR_PACKAGE_NAME),
  join(process.cwd(), "..", "..", "node_modules", CONNECTOR_PACKAGE_NAME),
]

function resolvePackageRoot(resolveExport?: PackageExportResolver): string {
  if (resolveExport) {
    const resolvedPackageJson = resolveExport(CONNECTOR_PACKAGE_JSON)
    return dirname(
      resolvedPackageJson.startsWith("file:")
        ? fileURLToPath(resolvedPackageJson)
        : resolvedPackageJson
    )
  }
  // The package uses an exports map that does not expose package.json in the
  // staged install. Probe the package root directly instead of resolving the
  // ./manifests export, which points at absent code.
  for (const packageRoot of INSTALLED_PACKAGE_ROOT_CANDIDATES) {
    if (existsSync(join(packageRoot, "package.json"))) {
      return packageRoot
    }
  }
  throw new Error(`Unable to resolve ${CONNECTOR_PACKAGE_NAME} package root`)
}

/** Resolve the installed package's package-root manifests directory. */
export function resolveInstalledConnectorManifestsDir(
  resolveExport?: PackageExportResolver
): string | null {
  try {
    const manifestsDir = join(resolvePackageRoot(resolveExport), "manifests")
    return existsSync(manifestsDir) && statSync(manifestsDir).isDirectory()
      ? manifestsDir
      : null
  } catch {
    return null
  }
}

/**
 * Resolve the committed connector manifests directory for tests. The real
 * manifests ship in the installed `@pdpp/polyfill-connectors` package (from
 * the vendored tarball), not in the source-tree `packages/polyfill-connectors`
 * (which lost its manifests in fce1b2a6b4, "retire five vendored source
 * trees"). Throws if no manifests directory can be found, since a test that
 * silently skips its assertions is worse than one that fails loudly.
 */
export function resolveCommittedManifestsDirForTests(): string {
  const installedManifestsDir = resolveInstalledConnectorManifestsDir()
  if (installedManifestsDir) {
    return installedManifestsDir
  }
  throw new Error(
    `Unable to resolve ${CONNECTOR_PACKAGE_NAME} manifests directory for tests`
  )
}
