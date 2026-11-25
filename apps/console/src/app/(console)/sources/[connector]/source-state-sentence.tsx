// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SourceStatusText } from "@/app/(console)/components/source-status-text.tsx";
import type { SourceStateSentence, SourceStatusWords } from "../../lib/source-status-words.ts";

export function SourceStateSentenceText({
  connectionId,
  sentence,
  status,
}: {
  connectionId: string;
  sentence: SourceStateSentence;
  status: SourceStatusWords;
}) {
  return (
    <p
      className="mb-6 max-w-3xl"
      data-source-id={connectionId}
      data-status-row={status.row}
      data-testid="source-state-sentence"
    >
      <SourceStatusText className="text-base" status={{ ...status, words: sentence.text }} />
      {sentence.slot === "what_is_kept_and_what_set_up_again_does" ? (
        <span className="block text-sm text-muted-foreground">
          Future syncing stops. Your records stay. Set up again starts a new setup for this data source.
        </span>
      ) : null}
      {sentence.slot === "what_you_can_do" ? (
        <span className="block text-sm text-muted-foreground">
          {status.action ? `Use “${status.action.label}” above.` : null}
        </span>
      ) : null}
    </p>
  );
}
