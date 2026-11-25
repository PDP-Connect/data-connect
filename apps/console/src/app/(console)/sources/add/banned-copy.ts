// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helper: the design's "Banned on these pages, by name" list as a check
 * on rendered markup. `trial-add/DESIGN-ADD.md`, items 1 to 10.
 */

const BANNED_WORDS: readonly [string, RegExp][] = [
  ["install", /\binstall(?:s|ed|ing|ation)?\b/i],
  ["package", /\bpackages?\b/i],
  ["connector", /\bconnectors?\b/i],
  ["manifest", /\bmanifests?\b/i],
  ["digest", /\bdigests?\b/i],
  ["registered", /\bregist(?:er|ered|ration)\b/i],
  ["operator", /\boperators?\b/i],
  ["instance", /\binstances?\b/i],
  ["dashboard", /\bdashboards?\b/i],
  ["setup path", /\bsetup paths?\b/i],
  ["modality", /\bmodality\b/i],
  ["credential", /\bcredentials?\b/i],
  ["seal", /\bseal(?:ed|s)?\b/i],
  ["browser-backed", /browser-backed/i],
  ["version number", /\bv?\d+\.\d+\.\d+\b|\bv\d+\b/i],
  ["badge: Experimental", /\bexperimental\b/i],
  ["badge: In testing", /\bin testing\b/i],
  ["badge: Preview", /\bpreview\b/i],
  ["badge: In development", /\bin development\b/i],
  ["sort or filter", /\b(?:sort|filter)\b/i],
  ["milliseconds", /\b\d+\s?ms\b/i],
  ["raw id", /\b(?:cin|run|conn)_[0-9a-f]{8,}\b/i],
  ["json", /[{]\s*"[a-z_]+"\s*:/i],
];

/** Visible words plus accessible names, with markup removed. */
export function visibleText(html: string): string {
  const labels = [...html.matchAll(/\b(?:aria-label|alt|title|placeholder)="([^"]*)"/g)].map((match) => match[1]).join(" ");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, " ");
  return `${text} ${labels}`;
}

export interface BannedCopyOptions {
  /** Words allowed on `/settings/packages` only. */
  readonly allowWords?: readonly string[];
  /** The one allowed fold: its summary text. Default "What went wrong". */
  readonly allowedFold?: string;
}

/** Returns a list of problems; empty means the markup obeys the banned list. */
export function bannedCopyProblems(html: string, options: BannedCopyOptions = {}): string[] {
  const problems: string[] = [];
  const allowedFold = options.allowedFold ?? "What went wrong";
  for (const match of html.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/g)) {
    const summary = (match[1] ?? "").replace(/<[^>]*>/g, "").trim();
    if (summary !== allowedFold) problems.push(`fold "${summary}"`);
  }
  if (/<details\b(?![^>]*>\s*<summary)/.test(html)) problems.push("fold without a summary");
  const text = visibleText(html);
  const allow = new Set((options.allowWords ?? []).map((word) => word.toLowerCase()));
  for (const [name, pattern] of BANNED_WORDS) {
    const hit = pattern.exec(text);
    if (!hit) continue;
    if (allow.has(hit[0].toLowerCase()) || allow.has(name)) continue;
    problems.push(`${name}: "${hit[0]}"`);
  }
  return problems;
}
