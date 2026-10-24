// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorIcon — a generic render of a manifest-declared connector icon.
 *
 * This component has ZERO knowledge of any specific connector. It renders
 * exactly what its `icon` prop carries (an `inline_svg` manifest declaration
 * — see `server/connector-manifest-validation.ts`'s `validateManifestIcon`)
 * and falls back to the shared Monogram primitive (a deterministic
 * initial+color derived from `name`) when `icon` is absent. There is no
 * connector-id -> icon map here or anywhere else in the console: every
 * caller passes the manifest value it already has, and a connector this
 * component has never heard of renders exactly as well as one it has.
 *
 * The no-icon state (Monogram) is a first-class, good-looking default — most
 * connectors will not declare an icon, so this is the common case, not a
 * degraded fallback.
 */
import type { CSSProperties } from "react";
import { Monogram } from "./data-row.tsx";
import "./connector-icon.css";

export interface ConnectorIconLike {
  /**
   * The connector's brand colour (`brand.background_color` in its manifest).
   * Connectors ship white glyphs meant for a tile in this colour, so when it
   * is present the icon draws that tile; without it a white glyph would
   * vanish on a light card.
   */
  readonly background?: string | null;
  readonly color?: string | null;
  readonly kind?: string | null;
  readonly svg?: string | null;
}

interface ConnectorIconProps {
  className?: string;
  /**
   * Manifest-declared icon, or undefined/null for the Monogram fallback.
   * Read only via the `icon && isRenderableInlineSvgIcon(icon)` truthiness
   * check below — "key present holding undefined" and "key absent" are the
   * same "no icon" to that check, so the type says so.
   */
  icon?: ConnectorIconLike | null | undefined;
  /** Owner-facing connector name — drives the Monogram fallback's initials and color. */
  name: string;
}

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Expand `#abc` to `#aabbcc`; null for anything that is not a plain hex colour. */
function normalizeHexColor(value: string | null | undefined): string | null {
  const hex = typeof value === "string" ? value.trim() : "";
  if (!HEX_COLOR_RE.test(hex)) {
    return null;
  }
  if (hex.length === 4) {
    return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
  }
  return hex.toLowerCase();
}

const GLYPH_LIGHT = "#ffffff";
const GLYPH_DARK = "#111111";
const MIN_GLYPH_CONTRAST = 3;

/** WCAG relative luminance of a normalized `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Tile colours for a brand colour: the tile itself plus a glyph colour that
 * stays legible on it (white unless the brand colour is light).
 * Returns null for an absent or non-hex value, so a malformed manifest value
 * can never reach a style attribute.
 */
export function brandTileColors(background: string | null | undefined): { background: string; glyph: string } | null {
  const normalized = normalizeHexColor(background);
  if (!normalized) {
    return null;
  }
  const luminance = relativeLuminance(normalized);
  // The connectors ship white glyphs designed for their brand colour, so keep
  // white until it falls below the 3:1 WCAG minimum for graphical objects.
  const whiteContrast = 1.05 / (luminance + 0.05);
  return { background: normalized, glyph: whiteContrast >= MIN_GLYPH_CONTRAST ? GLYPH_LIGHT : GLYPH_DARK };
}

function isRenderableInlineSvgIcon(icon: ConnectorIconLike): icon is ConnectorIconLike & { svg: string } {
  return icon.kind === "inline_svg" && typeof icon.svg === "string" && icon.svg.trim().length > 0;
}

// The SOLE choke point for icon.svg is assertSvgIsAllowlisted in
// reference-implementation/server/connector-manifest-validation.ts
// (validateManifestIcon). It is a strict ALLOWLIST of shape-only elements
// and attributes — no script, foreignObject, iframe, use, image, animate,
// set, style, a, or any href/xlink:href; see its doc comment for the full
// vocabulary — not a denylist, so there is no attack-vector list to keep
// exhaustive. It also re-runs on every read of a stored manifest
// (server/auth.ts's parseAndValidateConnectorManifestRow calls
// validateConnectorManifest, which calls validateManifestIcon, on every
// fetch), so icon.svg is validated immediately before this component ever
// sees it, not merely once at registration time.
export function ConnectorIcon({ icon, name, className }: ConnectorIconProps) {
  if (icon && isRenderableInlineSvgIcon(icon)) {
    const tile = brandTileColors(icon.background);
    const cls = ["pdpp-connector-icon", tile ? "pdpp-connector-icon--tile" : undefined, className]
      .filter(Boolean)
      .join(" ");
    const style = tile
      ? ({ "--pdpp-connector-glyph": tile.glyph, background: tile.background } as CSSProperties)
      : icon.color
        ? ({ color: icon.color } as CSSProperties)
        : undefined;
    return (
      <span
        aria-hidden="true"
        className={cls}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: see the allowlist choke-point comment above ConnectorIcon.
        dangerouslySetInnerHTML={{ __html: icon.svg }}
        style={style}
      />
    );
  }
  return <Monogram className={className} name={name} tinted />;
}
