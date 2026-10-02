// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectorIconLike } from "@pdpp/brand-react";
import { sanitizeSvg } from "./sanitize-svg.ts";

/**
 * Icon-resolution LAYER 2: a vendored, offline lookup into the simple-icons
 * npm package (CC0-licensed SVG markup, ~3,300 brand icons), used only when
 * a connector's manifest declares no bundled icon of its own (layer 1 in
 * resolve-connector-icon-path.ts). This exists for connectors added AFTER
 * today's fix — every manifest currently shipped already has a bundled icon,
 * so layer 1 alone covers the reported bug.
 *
 * Offline/build-time only: this reads a file the npm package already
 * installed on disk. It never fetches from a network at render time and
 * never calls a third-party logo CDN (logo.dev and similar are explicitly
 * out of scope — see the manifests/icons NOTICE for why).
 *
 * simple-icons' SVG markup is CC0 (public domain), but its LICENSE is
 * explicit that CC0 does not waive trademark rights, and it runs a formal
 * brand-owner takedown channel. Rendering one of its icons here is the same
 * nominative-fair-use posture as the vendored layer-1 icons: identification
 * only, no implied endorsement. See manifests/icons/NOTICE.md.
 */

const PACKAGE_NAME = "simple-icons";
const INSTALLED_PACKAGE_ROOT_CANDIDATES = [
  join(process.cwd(), "node_modules", PACKAGE_NAME),
  join(process.cwd(), "..", "..", "node_modules", PACKAGE_NAME),
];

interface SimpleIconEntry {
  slug: string;
  title: string;
}

let cachedPackageRoot: string | null | undefined;
let cachedSlugs: Set<string> | null | undefined;

function resolvePackageRoot(): string | null {
  if (cachedPackageRoot !== undefined) {
    return cachedPackageRoot;
  }
  for (const candidate of INSTALLED_PACKAGE_ROOT_CANDIDATES) {
    if (existsSync(join(candidate, "package.json"))) {
      cachedPackageRoot = candidate;
      return candidate;
    }
  }
  cachedPackageRoot = null;
  return null;
}

/** The set of every valid simple-icons slug, loaded once and cached. */
function loadKnownSlugs(packageRoot: string): Set<string> {
  if (cachedSlugs !== undefined && cachedSlugs !== null) {
    return cachedSlugs;
  }
  try {
    const raw = readFileSync(join(packageRoot, "data", "simple-icons.json"), "utf8");
    const entries = JSON.parse(raw) as SimpleIconEntry[];
    cachedSlugs = new Set(entries.map((entry) => entry.slug));
  } catch {
    cachedSlugs = new Set();
  }
  return cachedSlugs;
}

/**
 * Normalize a connector key to the slug shape simple-icons uses: lowercase,
 * digits and letters only. Matches simple-icons' own slug algorithm (a
 * lowercased title with non-alphanumeric characters stripped), so this is a
 * direct lookup rather than a fuzzy guess — verified against every
 * currently-shipped connector key with no false positives.
 */
function slugFromConnectorKey(connectorKey: string): string {
  return connectorKey.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a connector's icon from the vendored simple-icons corpus by
 * connector key (e.g. "claude-code" -> slug "claudecode"). Returns null
 * (never throws) when simple-icons is not installed, the key has no known
 * slug match, the icon file is missing, or its content fails sanitizeSvg —
 * any of which falls through to the deterministic Monogram (layer 3).
 */
export async function resolveConnectorIconFromSimpleIcons(connectorKey: string): Promise<ConnectorIconLike | null> {
  if (typeof connectorKey !== "string" || connectorKey.trim().length === 0) {
    return null;
  }
  const packageRoot = resolvePackageRoot();
  if (!packageRoot) {
    return null;
  }
  const slug = slugFromConnectorKey(connectorKey);
  if (!slug || !loadKnownSlugs(packageRoot).has(slug)) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(join(packageRoot, "icons", `${slug}.svg`), "utf8");
  } catch {
    return null;
  }
  const svg = sanitizeSvg(raw);
  if (!svg) {
    return null;
  }
  return { kind: "inline_svg", svg };
}
