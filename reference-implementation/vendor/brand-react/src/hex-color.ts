// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

/**
 * Returns `value` when it is a `#rgb` / `#rrggbb` string, else `null`.
 * The one check for every manifest color that reaches a browser style: a
 * free-form CSS value could smuggle extra declarations, such as a `url()`
 * fetch, into the `style` attribute.
 */
export function hexColorOrNull(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : null;
}
