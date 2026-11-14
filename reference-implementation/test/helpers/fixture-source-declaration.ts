// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../../server/source-declaration-legacy-collection.ts";

const FIXTURE_PUBLISHER = "https://publishers.pdpp.test/fixtures";

/**
 * Test-only. Gives a fixture manifest an explicit, validated source declaration computed from its own
 * final content, so a first registration of a fixture key with no reviewed legacy mapping goes through the
 * Core route. The source identity is the fixture's own (`https://fixtures.pdpp.test/sources/<slug>`), not a
 * production identity. Always recomputed from the content it is given, so a manifest derived by spreading
 * another fixture never keeps a declaration for content it no longer has.
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

const REGISTRY_CONNECTOR_PREFIX = /^https?:\/\/[^/]+\/connectors\//;
const NON_SLUG_CHARACTERS = /[^a-z0-9._-]/g;

function fixtureSlugOf(content: Record<string, unknown>): string {
  const key = typeof content.connector_key === "string" ? content.connector_key : String(content.connector_id);
  const tail = key.replace(REGISTRY_CONNECTOR_PREFIX, "");
  return tail.replace(NON_SLUG_CHARACTERS, "-");
}
