// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";

/** Route-level loading state for Data source updates: its trail, its title and the rows it shows. */
export default function PackagesLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Data source updates" }]} framed label="data source updates" shape="list" title="Data source updates" />
    </RecordroomShellWithPalette>
  );
}
