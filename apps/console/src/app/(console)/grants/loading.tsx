// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/** Route-level loading state for Apps: its trail, its title and the rows it shows. */
export default function GrantsLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton label="apps" rowAction={false} rows={3} shape="list" title="Apps" />
    </RecordroomShellWithPalette>
  );
}
