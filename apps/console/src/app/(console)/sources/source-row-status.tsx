// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SourceStatusText } from "../components/source-status-text.tsx";
import type { SourceInstanceView } from "./sources-view-model.ts";

const TIME_SEPARATOR = " · ";

/**
 * Status words that carry a time ("Trying again on its own · last synced 12 Jun")
 * split at the first dot: the time never breaks inside itself and drops to its own
 * line, without the dot, when the whole status does not fit. The words themselves
 * still come only from the shared status result.
 */
function splitStatusWhen(words: string): { head: string; when: string | null } {
  const at = words.indexOf(TIME_SEPARATOR);
  if (at === -1) {
    return { head: words, when: null };
  }
  return { head: words.slice(0, at), when: words.slice(at + TIME_SEPARATOR.length) };
}

export function SourceRowStatus({ instance }: { instance: SourceInstanceView }) {
  const { tone, words } = instance.statusWords;
  const { head, when } = splitStatusWhen(words);
  return (
    <span
      className="rr-s-row__status"
      data-source-id={instance.connectionId ?? instance.id}
      data-status-row={instance.statusWords.row}
    >
      <span className="rr-s-row__status-parts">
        <SourceStatusText className="rr-s-row__status-part" status={{ tone, words: head }} />
        {when ? <SourceStatusText className="rr-s-row__status-part rr-s-row__status-when" status={{ tone, words: when }} /> : null}
      </span>
    </span>
  );
}
