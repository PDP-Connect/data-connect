// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** A manifest property's own `title`, when it declares one; the record page labels a field with it. */
export function manifestFieldLabels(
  stream: { schema?: { properties?: Record<string, unknown> } } | null | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [name, property] of Object.entries(stream?.schema?.properties ?? {})) {
    const title = property && typeof property === "object" ? (property as { title?: unknown }).title : undefined;
    if (typeof title === "string" && title.trim()) labels[name] = title.trim();
  }
  return labels;
}

const LEADING_YOUR = /^your\s+/i;

/** "Your owned games" -> "Browse all owned games →": the link names the kind it opens. */
export function browseKindLinkText(kindLabel: string): string {
  const name = kindLabel.trim().replace(LEADING_YOUR, "");
  return name ? `Browse all ${name.charAt(0).toLowerCase()}${name.slice(1)} →` : "Browse all →";
}
