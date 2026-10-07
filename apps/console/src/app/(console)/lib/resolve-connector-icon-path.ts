// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConnectorIconLike } from "@pdpp/brand-react";
import { sanitizeSvg } from "./sanitize-svg.ts";

/**
 * Server-only counterpart to resolve-connector-icon.ts's inline_svg
 * validator. Manifests declare `brand.icon` as a relative path string (e.g.
 * "icons/amazon.svg") under the shipped connector-manifests directory, not
 * inline markup, so resolving it requires filesystem access that must never
 * reach the client bundle (resolve-connector-icon.ts is imported by
 * connector-mark.tsx, a "use client" component). This module is called only
 * from rs-client.ts's server-only listConnectorManifests(), which converts
 * the resolved, sanitized SVG into the same inline_svg shape
 * resolveConnectorIcon already renders.
 *
 * This is icon-resolution LAYER 1 (bundled-with-the-manifest, checked
 * first) of the three-layer resolver: layer 1 here, layer 2 in
 * resolve-connector-icon-simple-icons.ts, layer 3 (deterministic monogram)
 * already implemented by @pdpp/brand-react's ConnectorIcon fallback.
 */

/**
 * Resolve a manifest's `brand.icon` relative-path declaration (e.g.
 * "icons/amazon.svg") into the inline_svg shape ConnectorIcon renders.
 * `manifestsDir` must be the same directory connector-manifests-dir.ts
 * locates. Guards path traversal by requiring the resolved file stay inside
 * that directory, then requires the file content pass sanitizeSvg. Returns
 * null (never throws) for a missing file, a traversal attempt, or invalid
 * content, so a bad icon degrades to the Monogram fallback instead of
 * breaking the catalog.
 */
export async function resolveConnectorIconFromManifestPath(
  manifestsDir: string,
  iconPath: string
): Promise<ConnectorIconLike | null> {
  if (typeof iconPath !== "string" || iconPath.trim().length === 0) {
    return null;
  }
  const root = resolve(manifestsDir);
  const resolved = resolve(root, iconPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch {
    return null;
  }
  const svg = sanitizeSvg(raw);
  if (!svg) {
    return null;
  }
  return { kind: "inline_svg", svg };
}
