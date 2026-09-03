// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real connector icon SVGs for the consent design preview, read from this
 * route's own `icons/` directory — copies of PDP-Connect/data-connectors
 * connector icon SVGs. Originally committed under
 * `reference-implementation/server/assets/source-icons/` during the
 * reference-server round of this mock (4dbe7fa9f); moved here when that
 * route was retired (7ae7caed5) so this page owns the assets it depends on
 * instead of reaching into a directory that no longer exists.
 *
 * Loaded server-side at module init and passed through `ConnectorIcon`'s
 * `{ kind: "inline_svg", svg }` prop — the exact shape a real connector
 * manifest icon declaration takes (server/connector-manifest-validation.ts).
 * Sources with no entry here fall back to `ConnectorIcon`'s own Monogram,
 * never a bespoke initials hack.
 */
import "server-only";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_ICON_FILES } from "./mock-data.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, "icons");

function loadSvg(file: string): string | null {
  try {
    return readFileSync(join(ICONS_DIR, file), "utf8");
  } catch {
    return null;
  }
}

const CACHE = new Map<string, string | null>();

export interface SourceIcon {
  readonly kind: "inline_svg";
  readonly svg: string;
}

/** Returns the real inline SVG for a mock source id, or null for the Monogram fallback. */
export function sourceIcon(sourceId: string): SourceIcon | null {
  const file = SOURCE_ICON_FILES[sourceId];
  if (!file) {
    return null;
  }
  if (!CACHE.has(file)) {
    CACHE.set(file, loadSvg(file));
  }
  const svg = CACHE.get(file) ?? null;
  return svg ? { kind: "inline_svg", svg } : null;
}

export function clientLogoSvg(): string | null {
  if (!CACHE.has("chatgpt.svg")) {
    CACHE.set("chatgpt.svg", loadSvg("chatgpt.svg"));
  }
  return CACHE.get("chatgpt.svg") ?? null;
}
