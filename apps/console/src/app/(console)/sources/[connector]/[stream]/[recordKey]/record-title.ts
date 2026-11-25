// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { humanizeFieldLabel, type PreviewKind, type RecordPreview, rowPrimary } from "@pdpp/display";
import { exploreRecordTitle } from "../../../../explore/explore-presentation.ts";

/**
 * The preview the record page's title is drawn from, using the exact title rule
 * Explore uses for a kind row.
 */
export function recordTitlePreview(
  preview: RecordPreview | null,
  kind: PreviewKind,
  streamName: string
): RecordPreview {
  return {
    ...preview,
    kind,
    title: exploreRecordTitle({ preview: preview ?? undefined, stream: streamName }),
  };
}

/** The last breadcrumb: the record's title, or none when it repeats the kind crumb. */
export function recordCrumbLabel(titlePreview: RecordPreview, streamName: string): string | null {
  const title = rowPrimary(titlePreview);
  return title === humanizeFieldLabel(streamName) ? null : title;
}
