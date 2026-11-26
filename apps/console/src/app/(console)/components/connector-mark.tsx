// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorIcon, type ConnectorIconLike } from "@pdpp/brand-react";
import { createElement, type CSSProperties } from "react";
import { resolveConnectorIcon, resolveSourceIcon } from "../lib/resolve-connector-icon.ts";

const TEXT_SPACING_CLASSES = { after: "mr-2", around: "mx-1" } as const;

/** Decide whether an SVG is safe to recolour as a text-colour mask. */
export function isSingleColorConnectorIcon(icon: ConnectorIconLike | null | undefined): boolean {
  if (icon?.kind !== "inline_svg" || typeof icon.svg !== "string") return false;
  if (/\b(?:class|style)\s*=|<style\b/i.test(icon.svg)) return false;

  const inheritedPaints: Array<{ fill: string; stroke: string }> = [];
  const colors = new Set<string>();
  const shapeTags = new Set(["path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);
  const tags = /<\s*(\/?)\s*([a-z][\w:.-]*)([^>]*?)(\/?)\s*>/gi;
  for (const [, closing, name = "", attributes = "", selfClosing] of icon.svg.matchAll(tags)) {
    if (closing) {
      inheritedPaints.pop();
      continue;
    }
    const attributePaint = (attribute: "fill" | "stroke") =>
      new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']*)["']`, "i").exec(attributes)?.[1];
    const parent = inheritedPaints.at(-1);
    const resolvePaint = (attribute: "fill" | "stroke", initial: string) => {
      const paint = attributePaint(attribute)?.trim().toLowerCase();
      if (paint === "inherit" || paint === "unset") return parent?.[attribute] ?? initial;
      return paint ?? parent?.[attribute] ?? initial;
    };
    const fill = resolvePaint("fill", "black");
    const stroke = resolvePaint("stroke", "none");

    if (shapeTags.has(name.toLowerCase())) {
      for (const paint of [fill, stroke]) {
        if (!paint || paint === "none" || paint === "transparent") continue;
        if (paint.startsWith("url(") || paint.includes("gradient")) return false;
        colors.add(paint);
      }
    }

    if (!selfClosing) inheritedPaints.push({ fill, stroke });
  }
  return colors.size === 1;
}

/** One connector identity mark for every console surface. */
export function ConnectorMark({
  spacing,
  connectorId,
  sourceId,
  icon,
  name,
}: {
  /** Space between this mark and adjacent inline text; geometry belongs to the renderer. */
  spacing?: keyof typeof TEXT_SPACING_CLASSES;
  icon?: ConnectorIconLike | null;
  name: string;
} & ({ connectorId: string; sourceId?: never } | { sourceId: string; connectorId?: never })) {
  const resolvedIcon = sourceId === undefined ? resolveConnectorIcon(connectorId, icon) : resolveSourceIcon(sourceId, icon);
  if (resolvedIcon && !resolvedIcon.backgroundColor && isSingleColorConnectorIcon(resolvedIcon)) {
    const mask = `url("data:image/svg+xml,${encodeURIComponent(resolvedIcon.svg ?? "")}")`;
    return createElement("span", {
      "aria-hidden": true,
      className: ["pdpp-connector-icon", "bg-foreground", spacing ? TEXT_SPACING_CLASSES[spacing] : undefined]
        .filter(Boolean)
        .join(" "),
      style: {
        maskImage: mask,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "60% 60%",
        WebkitMaskImage: mask,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "60% 60%",
      } as CSSProperties,
    });
  }
  return createElement(ConnectorIcon, {
    className: spacing ? TEXT_SPACING_CLASSES[spacing] : undefined,
    icon: resolvedIcon,
    name: resolvedIcon ? name : Array.from(name.trim())[0] ?? "?",
  });
}
