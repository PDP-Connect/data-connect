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
  const [statusSentence, secondText] = status.row === 8
    ? splitAfterFirstSentence(sentence.text)
    : [sentence.text, null];
  return (
    <p
      className="mb-6 max-w-3xl"
      data-source-id={connectionId}
      data-status-row={status.row}
      data-source-words={status.words}
      data-source-action={status.action?.label ?? ""}
      data-testid="source-state-sentence"
    >
      <SourceStatusText className={status.tone === "attention" ? "!text-[length:var(--text-body)]" : "!text-[length:var(--text-body)] !text-foreground"} status={{ ...status, words: statusSentence }} />
      {secondText ? <><span> </span><span className="block pdpp-body text-muted-foreground">{secondText}</span></> : null}
      {sentence.slot === "what_is_kept_and_what_set_up_again_does" ? (
        <span className="block pdpp-body text-muted-foreground">
          Future syncing stops. Your records stay. Set up again starts a new setup for this data source.
        </span>
      ) : null}
    </p>
  );
}

function splitAfterFirstSentence(value: string): [string, string | null] {
  const end = value.indexOf(". ");
  return end < 0 ? [value, null] : [value.slice(0, end + 1), value.slice(end + 2)];
}
