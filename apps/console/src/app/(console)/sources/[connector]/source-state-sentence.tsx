// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SourceStatusText } from "@/app/(console)/components/source-status-text.tsx";
import type { SourceStateSentence, SourceStatusWords } from "../../lib/source-status-words.ts";

const UP_TO_DATE_PREFIX = /^Up to date\. /;
const NEXT_CHECK_SUFFIX = /; next [^.]+/;
const UNCHECKED_AGAINST_SOURCE_SUFFIX = /\. DataConnect has not checked this against the source\.$/;

export function SourceStateSentenceText({
  connectionId,
  pendingDetails = false,
  sentence,
  status,
}: {
  connectionId: string;
  pendingDetails?: boolean;
  sentence: SourceStateSentence;
  status: SourceStatusWords;
}) {
  const syncedSentence = pendingDetails && (status.row === 19 || status.row === 20)
    ? sentence.text
        .replace(UP_TO_DATE_PREFIX, "")
        .replace(NEXT_CHECK_SUFFIX, "")
        .replace(UNCHECKED_AGAINST_SOURCE_SUFFIX, ".")
    : sentence.text;
  const [statusSentence, secondText] = status.row === 8
    ? splitAfterFirstSentence(syncedSentence)
    : [syncedSentence, null];
  return (
    <p
      className="mb-6 max-w-3xl"
      data-source-id={connectionId}
      data-status-row={status.row}
      data-testid="source-state-sentence"
    >
      <SourceStatusText className="text-base" status={{ ...status, words: statusSentence }} />
      {secondText ? <><span> </span><span className="block text-muted-foreground text-sm">{secondText}</span></> : null}
      {sentence.slot === "what_is_kept_and_what_set_up_again_does" ? (
        <span className="block text-muted-foreground text-sm">
          Future syncing stops. Your records stay. Set up again starts a new setup for this data source.
        </span>
      ) : null}
      {pendingDetails ? <><span> </span><span className="block text-muted-foreground text-sm">Some details are still being fetched.</span></> : null}
    </p>
  );
}

function splitAfterFirstSentence(value: string): [string, string | null] {
  const end = value.indexOf(". ");
  return end < 0 ? [value, null] : [value.slice(0, end + 1), value.slice(end + 2)];
}
