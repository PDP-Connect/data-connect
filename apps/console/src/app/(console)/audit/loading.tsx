// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/**
 * Route-level loading state for the traces list.
 *
 * `/audit` lists protocol traces (and optionally peeks a timeline)
 * from the reference deployment, which can be slow on a busy instance. Keep the
 * shell stable and animate a list skeleton while the data resolves.
 */
/**
 * Now drawn with the page's own title and trail so the title does not jump.
 */
export default function TracesLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton label="activity" rows={8} shape="list" title="Activity" />
    </RecordroomShellWithPalette>
  );
}
