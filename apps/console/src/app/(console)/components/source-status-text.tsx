// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SourceStatusTone, SourceStatusWords } from "../lib/source-status-words.ts";

/**
 * The status words of one data source, in the tone the wording function chose.
 * Home, the data sources list and the data source page all draw status through
 * this component, so the same state reads and looks the same in all three.
 */
const TONE_CLASS: Record<SourceStatusTone, string> = {
  accent: "text-primary",
  attention: "font-medium text-attention",
  faint: "text-muted-foreground",
  plain: "text-muted-foreground",
};

export function SourceStatusText({
  className,
  status,
}: {
  className?: string;
  status: Pick<SourceStatusWords, "tone" | "words">;
}) {
  return (
    <span
      className={["text-[13px] tabular-nums", TONE_CLASS[status.tone], className].filter(Boolean).join(" ")}
      data-status-tone={status.tone}
    >
      {status.words}
    </span>
  );
}
