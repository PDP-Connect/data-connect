// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import "./sources-view.css";
import { SourcesLoadingSkeleton } from "./sources-loading-skeleton.tsx";

/**
 * Route-level loading state for the data sources list.
 *
 * `/sources` loads a bounded page of summaries. This placeholder keeps the
 * list shape while that read resolves.
 */
export default function RecordsLoading() {
  return (
    <RecordroomShellWithPalette>
      <SourcesLoadingSkeleton />
    </RecordroomShellWithPalette>
  );
}
