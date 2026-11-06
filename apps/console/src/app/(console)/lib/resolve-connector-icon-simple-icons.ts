// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectorIconLike } from "@pdpp/brand-react";
import { sanitizeSvg } from "@pdpp/brand-react/sanitize-svg";

/**
 * The `generic` layer of `pickDisplayMark` (resolve-manifest-display-mark.ts):
 * an offline lookup into the installed simple-icons npm package (CC0-licensed
 * SVG markup, ~3,400 brand icons), used only when neither the manifest nor
 * the bundled corpus supplies a mark. This exists for connectors added AFTER
 * the bundled corpus was generated.
 *
 * Offline/build-time only: this reads a file the npm package already
 * installed on disk. It never fetches from a network at render time and
 * never calls a third-party logo CDN (logo.dev and similar are explicitly
 * out of scope — see the connector-icons NOTICE for the attribution terms).
 *
 * simple-icons' SVG markup is CC0 (public domain), but its LICENSE is
 * explicit that CC0 does not waive trademark rights, and it runs a formal
 * brand-owner takedown channel. Rendering one of its icons here is the same
 * nominative-fair-use posture as the bundled icons: identification only, no
 * implied endorsement. See connector-icons/NOTICE.
 */

const PACKAGE_NAME = "simple-icons";
/** What the lookup reads; the build's file tracer copies exactly these (next.config.mjs). */
const SLUG_INDEX = join("data", "simple-icons.json");

interface SimpleIconEntry {
  slug: string;
  title: string;
}

// Keyed by cwd, because the candidate roots are relative to it: Next's
// standalone server.js chdirs into apps/console, and a test may chdir too.
const packageRootByCwd = new Map<string, string | null>();
const slugsByRoot = new Map<string, Set<string>>();

function resolvePackageRoot(): string | null {
  const cwd = process.cwd();
  const cached = packageRootByCwd.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  const root =
    [join(cwd, "node_modules", PACKAGE_NAME), join(cwd, "..", "..", "node_modules", PACKAGE_NAME)].find((candidate) =>
      existsSync(join(candidate, SLUG_INDEX))
    ) ?? null;
  packageRootByCwd.set(cwd, root);
  return root;
}

/** The set of every valid simple-icons slug, loaded once per package root and cached. */
function loadKnownSlugs(packageRoot: string): Set<string> {
  const cached = slugsByRoot.get(packageRoot);
  if (cached) {
    return cached;
  }
  let slugs: Set<string>;
  try {
    const raw = readFileSync(join(packageRoot, SLUG_INDEX), "utf8");
    slugs = new Set((JSON.parse(raw) as SimpleIconEntry[]).map((entry) => entry.slug));
  } catch {
    slugs = new Set();
  }
  slugsByRoot.set(packageRoot, slugs);
  return slugs;
}

/**
 * Normalize a connector key to the slug shape simple-icons uses: lowercase,
 * digits and letters only. Matches simple-icons' own slug algorithm (a
 * lowercased title with non-alphanumeric characters stripped), so this is a
 * direct lookup rather than a fuzzy guess. Separators are dropped, so
 * `foo-bar` and `foobar` name the same slug: a connector whose key only
 * coincides with another brand's slug would show that brand's mark.
 */
function slugFromConnectorKey(connectorKey: string): string {
  return connectorKey.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a connector's icon from the vendored simple-icons corpus by
 * connector key (e.g. "claude-code" -> slug "claudecode"). Returns null
 * (never throws) when simple-icons is not installed, the key has no known
 * slug match, the icon file is missing, or its content fails sanitizeSvg —
 * any of which falls through to the deterministic Monogram.
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
  if (!(slug && loadKnownSlugs(packageRoot).has(slug))) {
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
