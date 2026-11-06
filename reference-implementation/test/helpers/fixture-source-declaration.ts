// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../../server/source-declaration-legacy-collection.ts";

const FIXTURE_PUBLISHER = "https://publishers.pdpp.test/fixtures";

/**
 * Test-only. Gives a fixture manifest an explicit, validated source declaration computed from its own
 * final content, so registration uses the fixture's authored source identity instead of inferring one from
 * the manifest's `connector_id` or `manifest_uri`. The default identity is the fixture's own
 * (`https://fixtures.pdpp.test/sources/<slug>`), not a production identity; pass `sourceId` to pin another.
 * Always recomputed from the content it is given, so a manifest derived by spreading another fixture never
 * keeps a declaration for content it no longer has.
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
