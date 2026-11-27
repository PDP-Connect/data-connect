// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../../server/source-declaration-legacy-collection.ts";

export const FIXTURE_PUBLISHER = "https://publishers.pdpp.test/fixtures";

/**
 * Test-only. Gives a fixture manifest an explicit, validated source declaration computed from its own
 * final content, so a first registration of a fixture key with no reviewed legacy mapping goes through the
 * Core route. The default source identity is `https://fixtures.pdpp.test/sources/<slug>`; options.sourceId
 * can retain the identity of an edited fixture. Always recomputed from final content, so a manifest
 * derived by spreading another fixture never keeps a declaration for content it no longer has.
 */
export function withFixtureSourceDeclaration<T extends object>(manifest: T, options: { sourceId?: string } = {}): T {
  const content = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "source_declaration")
  ) as Record<string, unknown>;
  const slug = fixtureSlugOf(content);
  return {
    ...content,
    source_declaration: snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(content, {
      connectorImplementationId: `https://fixtures.pdpp.test/implementations/${slug}`,
      publisherId: FIXTURE_PUBLISHER,
      sourceId: options.sourceId ?? `https://fixtures.pdpp.test/sources/${slug}`,
    }),
  } as T;
}

/**
 * Re-author a deliberately edited fixture under the fixture issuer. Discards its old declaration and
 * regenerates from final manifest content, keeping only the old source id. Do not use for unchanged
 * stored-row round trips: those must submit the original declaration to exercise idempotent registration.
 */
export function withReauthoredFixtureDeclaration<T extends object>(manifest: T): T {
  const declaration = (manifest as Record<string, unknown>).source_declaration as { source?: { id?: unknown } } | undefined;
  const sourceId = declaration?.source?.id;
  if (typeof sourceId !== "string") throw new Error("Stored fixture manifest must retain its source identity");
  return withFixtureSourceDeclaration(manifest, { sourceId });
}

const NON_SLUG_CHARACTER = /[^a-z0-9._-]/;

/**
 * Injective: two different connector keys never share a slug, so two fixtures never share a source identity.
 * Every character outside `[a-z0-9._-]`, and a leading `.`, is written as `~<hex code point>~`. `~` is itself
 * escaped, so an escape sequence cannot be forged by a plain character, and a key that is already a clean slug
 * keeps its own name.
 */
export function fixtureSlugOf(content: Record<string, unknown>): string {
  const key = typeof content.connector_key === "string" ? content.connector_key : String(content.connector_id);
  return Array.from(key, (character, index) =>
    NON_SLUG_CHARACTER.test(character) || (index === 0 && character === ".")
      ? `~${character.codePointAt(0)?.toString(16)}~`
      : character
  ).join("");
}
