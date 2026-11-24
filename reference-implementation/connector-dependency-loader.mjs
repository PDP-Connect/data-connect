// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const runtimeRootUrl = new URL("../", import.meta.url).href
const runtimeParentUrl = new URL("./server/index.ts", import.meta.url).href

export function connectorChildArgs(connectorPath, loaderBootstrapUrl) {
  return [
    ...(connectorPath.endsWith(".ts") ? ["--import", "tsx/esm"] : []),
    "--import",
    loaderBootstrapUrl,
    connectorPath,
  ]
}

function isBarePackageSpecifier(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)
  )
}

export async function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL
  const isExternalImporter =
    typeof parentURL === "string" && !parentURL.startsWith(runtimeRootUrl)

  if (!isExternalImporter || !isBarePackageSpecifier(specifier)) {
    return nextResolve(specifier, context)
  }

  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error

    // Installed connectors live outside the staged RI tree. Retry a missing
    // bare import from the RI entrypoint so Node applies normal ESM package
    // exports and conditions against the shared, bundled node_modules.
    return nextResolve(specifier, { ...context, parentURL: runtimeParentUrl })
  }
}
