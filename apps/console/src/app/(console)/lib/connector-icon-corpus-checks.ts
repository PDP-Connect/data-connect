// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { hexColorOrNull } from "@pdpp/brand-react/hex-color";
import { connectorIconIdentityKeys } from "./connector-icon-identity.ts";

interface CorpusEntryLike {
  readonly background_color?: string | null;
  readonly connector_id: string;
  readonly connector_key: string;
  readonly source_id?: string | null;
  readonly svg: string;
}

/**
 * Fail when the pinned icon corpus could make a shipped mark depend on file
 * order or carry a free-form style value. The runtime indexes marks by every
 * accepted spelling of an identity, so the check runs on those spellings, not
 * on the raw strings:
 *   - no two entries may claim one normalized identity (`foo_bar`/`foo-bar`,
 *     or a registry-prefixed id that spells another entry's key);
 *   - `background_color` is a hex color when present;
 *   - entries sharing a `source_id` carry the same svg and background, since
 *     the source lookup would otherwise resolve to no brand.
 */
export function assertIconCorpusConsistent(entries: readonly CorpusEntryLike[]): void {
  const identityOwner = new Map<string, CorpusEntryLike>();
  const sourceMark = new Map<string, CorpusEntryLike>();
  for (const entry of entries) {
    assertHexBackground(entry);
    claimIdentities(entry, identityOwner);
    if (entry.source_id) {
      assertSameSourceMark(entry, entry.source_id, sourceMark);
    }
  }
}

function assertHexBackground(entry: CorpusEntryLike): void {
  const background = entry.background_color;
  if (background !== undefined && background !== null && hexColorOrNull(background) === null) {
    throw new Error(`Icon ${entry.connector_key} has a background_color that is not a hex color.`);
  }
}

function claimIdentities(entry: CorpusEntryLike, owners: Map<string, CorpusEntryLike>): void {
  for (const identity of [entry.connector_id, entry.connector_key]) {
    for (const key of connectorIconIdentityKeys(identity)) {
      const owner = owners.get(key);
      if (owner !== undefined && owner !== entry) {
        throw new Error(`Icons ${owner.connector_key} and ${entry.connector_key} claim the same identity "${key}".`);
      }
      owners.set(key, entry);
    }
  }
}

function assertSameSourceMark(entry: CorpusEntryLike, sourceId: string, first: Map<string, CorpusEntryLike>): void {
  const previous = first.get(sourceId);
  if (previous && (previous.svg !== entry.svg || previous.background_color !== entry.background_color)) {
    throw new Error(
      `Icons ${previous.connector_key} and ${entry.connector_key} share source ${sourceId} with different marks.`
    );
  }
  first.set(sourceId, previous ?? entry);
}
