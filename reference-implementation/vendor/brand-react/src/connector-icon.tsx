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
 * connector-specific lookup here: callers pass a normalized display mark.
 *
 * Callers resolve and validate connector assets before rendering. Missing
 * or rejected assets use the shared deterministic Monogram fallback.
 */
import type { CSSProperties } from "react";
import { Monogram } from "./data-row.tsx";
import "./connector-icon.css";

export interface ConnectorIconLike {
  /** Display-only backdrop from the connector brand declaration. */
  readonly backgroundColor?: string | null;
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

function isRenderableInlineSvgIcon(icon: ConnectorIconLike): icon is ConnectorIconLike & { svg: string } {
  return icon.kind === "inline_svg" && typeof icon.svg === "string" && icon.svg.trim().length > 0;
}

// Callers validate SVG markup with the server manifest allowlist or the
// console's shape-only SVG allowlist before passing it to this primitive.
export function ConnectorIcon({ icon, name, className }: ConnectorIconProps) {
  const cls = ["pdpp-connector-icon", className].filter(Boolean).join(" ");
  if (icon && isRenderableInlineSvgIcon(icon)) {
    return (
      <span
        aria-hidden="true"
        className={cls}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: callers apply the shape-only SVG allowlist before rendering.
        dangerouslySetInnerHTML={{ __html: icon.svg }}
        style={
          icon.color || icon.backgroundColor
            ? ({ color: icon.color ?? undefined, backgroundColor: icon.backgroundColor ?? undefined } as CSSProperties)
            : undefined
        }
      />
    );
  }
  return (
    <span aria-hidden="true" className={cls}>
      <Monogram name={name} tinted />
    </span>
  );
}
