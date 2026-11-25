// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Step 1: Export your data" (design "File services"): the service's own
 * instructions printed as numbered steps; other ways to export as plain links.
 */

export interface AcquisitionMethodLike {
  readonly detail: string | null;
  readonly help_url: string | null;
  readonly label: string;
  readonly platform: string | null;
  readonly posture: string | null;
}

export interface ExportLink {
  readonly href: string;
  readonly label: string;
}

export interface ExportInstructions {
  readonly links: readonly ExportLink[];
  readonly steps: readonly string[];
}

function stepsFromDetail(detail: string): string[] {
  return detail
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
}

export function exportInstructions(methods: readonly AcquisitionMethodLike[]): ExportInstructions {
  const primary = methods.filter((method) => method.posture === "primary");
  const leading = primary.length > 0 ? primary : methods.slice(0, 1);
  const steps = leading.flatMap((method) => (method.detail ? stepsFromDetail(method.detail) : [method.label]));
  const links: ExportLink[] = [];
  for (const method of methods) {
    if (method.help_url) links.push({ href: method.help_url, label: method.label });
  }
  return { links, steps };
}
