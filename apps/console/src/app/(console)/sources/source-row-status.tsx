// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SourceStatusText } from "../components/source-status-text.tsx";
import type { SourceInstanceView } from "./sources-view-model.ts";

export function SourceRowStatus({ instance }: { instance: SourceInstanceView }) {
  return (
    <span
      className="rr-s-row__status"
      data-source-id={instance.connectionId ?? instance.id}
      data-status-row={instance.statusWords.row}
    >
      <SourceStatusText status={instance.statusWords} />
    </span>
  );
}
