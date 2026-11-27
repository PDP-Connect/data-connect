// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/**
 * Route-level loading state for global search.
 *
 * `/search` is `force-dynamic` and awaits a reference `refSearch`
 * read across grants, runs, and traces before it can render its result groups.
 * Keep the shell stable and animate a list skeleton while that read resolves,
 * rather than painting a blank frame.
 */
export default function SearchLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton label="search" rows={6} shape="list" title="Search" />
    </RecordroomShellWithPalette>
  );
}
