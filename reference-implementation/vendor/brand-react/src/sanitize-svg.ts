// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared SVG allowlist sanitizer for brand glyphs read from disk (shipped
 * manifest icons and, when available, vendored simple-icons marks). This is
 * the sole XSS defense before content reaches dangerouslySetInnerHTML in
 * @pdpp/brand-react's ConnectorIcon — see that component's doc comment.
 *
 * A shape-only vocabulary: no script, foreignObject, iframe, use, image,
 * animate/animateTransform/set, style, a, or any href/xlink:href. Nothing in
 * this allowlist can execute script, fetch, or navigate. `role` and
 * `aria-hidden` are included because every real shipped icon (both our own
 * manifests and simple-icons' corpus) declares one or both on the root
 * `<svg>`; they carry no injectable value shape.
 */
const SVG_ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "title",
  "defs",
]);
const SVG_ALLOWED_ATTRIBUTES = new Set([
  "viewbox",
  "xmlns",
  "width",
  "height",
  "role",
  "aria-hidden",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "opacity",
  "fill-rule",
  "clip-rule",
  "transform",
]);
const SVG_ATTRIBUTE_VALUE_DENY_RE = /javascript:|data:|url\(/i;
const SVG_MAX_LENGTH = 10_000;

const SVG_TAG_RE = /<([^>]*)>/g;
const SVG_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const SVG_TAG_NAME_RE = /^([a-zA-Z_:][-a-zA-Z0-9_:.]*)/;

interface ParsedSvgTag {
  attrs: Map<string, string>;
  attrsExhaustive: boolean;
  closing: boolean;
  name: string;
  selfClosing: boolean;
}

function parseSvgTag(raw: string): ParsedSvgTag | null {
  let body = raw.trim();
  const closing = body.startsWith("/");
  if (closing) {
    body = body.slice(1).trim();
  }
  const selfClosing = body.endsWith("/");
  if (selfClosing) {
    body = body.slice(0, -1).trim();
  }
  const nameMatch = SVG_TAG_NAME_RE.exec(body);
  const rawName = nameMatch?.[1];
  if (!rawName) {
    return null;
  }
  const name = rawName.toLowerCase();
  const attrSource = body.slice(rawName.length);
  const attrs = new Map<string, string>();
  SVG_ATTR_RE.lastIndex = 0;
  let match = SVG_ATTR_RE.exec(attrSource);
  while (match) {
    const [, rawAttrName, doubleQuoted, singleQuoted] = match;
    if (rawAttrName) {
      const attrName = rawAttrName.toLowerCase();
      const attrValue = doubleQuoted ?? singleQuoted ?? "";
      // Browsers retain the first duplicate and decode character references.
      // Shape-only attributes need neither form, so reject duplicates and both escape forms before indexing.
      if (attrs.has(attrName) || attrValue.includes("&") || attrValue.includes("\\")) {
        return null;
      }
      attrs.set(attrName, attrValue);
    }
    match = SVG_ATTR_RE.exec(attrSource);
  }
  const attrsExhaustive = attrSource.replace(SVG_ATTR_RE, "").trim().length === 0;
  return { attrs, attrsExhaustive, closing, name, selfClosing };
}

function isAllowedSvgTag(tag: ParsedSvgTag | null): tag is ParsedSvgTag {
  if (!tag?.attrsExhaustive) {
    return false;
  }
  return (
    SVG_ALLOWED_ELEMENTS.has(tag.name) &&
    [...tag.attrs].every(
      ([name, value]) => SVG_ALLOWED_ATTRIBUTES.has(name) && !SVG_ATTRIBUTE_VALUE_DENY_RE.test(value)
    )
  );
}

/** Consume one well-formed element, keeping the unmatched opening names. */
function advanceSvgNesting(tag: ParsedSvgTag, openElements: string[]): boolean {
  if (tag.closing) {
    return !tag.selfClosing && tag.attrs.size === 0 && openElements.pop() === tag.name;
  }
  if (openElements.length === 0 && tag.name !== "svg") {
    return false;
  }
  if (!tag.selfClosing) {
    openElements.push(tag.name);
  }
  return true;
}

/**
 * A strict ALLOWLIST of shape-only SVG elements/attributes (reject anything
 * not explicitly permitted), a required bare `<svg>` root, and a denylist of
 * `javascript:`/`data:`/`url()` substrings inside any attribute value.
 * Returns the trimmed SVG on success, or null on any violation.
 */
export function sanitizeSvg(raw: string): string | null {
  const svg = raw.trim();
  if (svg.length === 0 || svg.length > SVG_MAX_LENGTH) {
    return null;
  }
  SVG_TAG_RE.lastIndex = 0;
  const openElements: string[] = [];
  let sawSvgRoot = false;
  let cursor = 0;
  let match = SVG_TAG_RE.exec(svg);
  while (match) {
    const between = svg.slice(cursor, match.index);
    if (between.includes("<") || (openElements.length === 0 && between.trim().length > 0)) {
      return null;
    }
    cursor = SVG_TAG_RE.lastIndex;
    const parsed = parseSvgTag(match[1] ?? "");
    if (!isAllowedSvgTag(parsed)) {
      return null;
    }
    const startsRoot = !parsed.closing && openElements.length === 0;
    if ((startsRoot && sawSvgRoot) || !advanceSvgNesting(parsed, openElements)) {
      return null;
    }
    sawSvgRoot ||= startsRoot;
    match = SVG_TAG_RE.exec(svg);
  }
  return sawSvgRoot && openElements.length === 0 && svg.slice(cursor).trim().length === 0 ? svg : null;
}
