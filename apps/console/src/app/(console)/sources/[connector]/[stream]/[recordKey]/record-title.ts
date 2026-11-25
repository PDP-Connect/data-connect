// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { humanizeFieldLabel, type PreviewKind, type RecordPreview, rowPrimary } from "@pdpp/display";

/**
 * The preview the record page's title is drawn from. Same rule as an Explore
 * row (`rowPrimary`): a declared title, body, amount or author when the record
 * has one. Where Explore would fall to a "label: value" field line, the page
 * uses the kind's human name instead.
 */
export function recordTitlePreview(
  preview: RecordPreview | null,
  kind: PreviewKind,
  streamName: string
): RecordPreview {
  // Mirrors the first step of `rowPrimary`, so the header shows this value.
  const declared = preview?.title ?? preview?.body ?? preview?.amount ?? preview?.author;
  if (preview && declared?.trim()) {
    return preview;
  }
  return { kind, title: humanizeFieldLabel(streamName) };
}

/** The last breadcrumb: the record's title, or none when it repeats the kind crumb. */
export function recordCrumbLabel(titlePreview: RecordPreview, streamName: string): string | null {
  const title = rowPrimary(titlePreview);
  return title === humanizeFieldLabel(streamName) ? null : title;
}
