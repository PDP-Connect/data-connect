// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests"

const CONNECTOR_KEY_RE = /^[a-z0-9_-]+$/
const SVG_RE = /\.svg$/i
const manifestRegistryPath = fileURLToPath(
  import.meta.resolve("@pdpp/polyfill-connectors/manifests")
)
const manifestsDirectory = realpathSync(
  resolve(dirname(manifestRegistryPath), "..", "manifests")
)

interface ConnectorBrandManifest {
  readonly brand?: { readonly dark_icon?: unknown; readonly icon?: unknown }
  readonly connector_key?: unknown
}

function manifestForConnectorKey(
  connectorKey: string
): ConnectorBrandManifest | null {
  if (!CONNECTOR_KEY_RE.test(connectorKey)) {
    return null
  }
  for (const { manifest } of readPolyfillManifests()) {
    if (!manifest || typeof manifest !== "object") {
      continue
    }
    const candidate = manifest as ConnectorBrandManifest
    if (candidate.connector_key === connectorKey) {
      return candidate
    }
  }
  return null
}

function isContainedPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return (
    pathFromParent !== "" &&
    !pathFromParent.startsWith("..") &&
    !isAbsolute(pathFromParent)
  )
}

function withSvgNamespace(bytes: Uint8Array): Uint8Array {
  const source = Buffer.from(bytes).toString("utf8")
  const openingTag = source.match(/<svg\b[^>]*>/i)?.[0]
  if (!openingTag || /\bxmlns\s*=/i.test(openingTag)) {
    return bytes
  }
  const namespacedTag = openingTag.replace(
    /^<svg\b/i,
    '<svg xmlns="http://www.w3.org/2000/svg"'
  )
  return Buffer.from(source.replace(openingTag, namespacedTag))
}

function readManifestSvg(iconPath: unknown): Uint8Array | null {
  if (
    typeof iconPath !== "string" ||
    isAbsolute(iconPath) ||
    !SVG_RE.test(iconPath)
  ) {
    return null
  }
  const candidatePath = resolve(manifestsDirectory, iconPath)
  if (!isContainedPath(manifestsDirectory, candidatePath)) {
    return null
  }
  try {
    const realPath = realpathSync(candidatePath)
    return isContainedPath(manifestsDirectory, realPath)
      ? withSvgNamespace(readFileSync(realPath))
      : null
  } catch {
    return null
  }
}

/** Reads one manifest-declared SVG from the installed connector package. */
export function readConnectorBrandIcon(
  connectorKey: string,
  dark: boolean
): Uint8Array | null {
  const manifest = manifestForConnectorKey(connectorKey)
  if (!manifest?.brand) {
    return null
  }
  return readManifestSvg(dark ? manifest.brand.dark_icon : manifest.brand.icon)
}
