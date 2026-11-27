// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";
import { AddSourceListSkeleton } from "./add-source-list.tsx";

/** Route-level loading state for "Add a data source": its trail, its title and the list of services. */
export default function AddSourceLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton
        breadcrumbs={[{ href: "/", label: "Home" }, { href: "/sources", label: "Data sources" }, { label: "Add a data source" }]}
        label="the list of services"
        shape="none"
        title="Add a data source"
      >
        <AddSourceListSkeleton />
      </NamedPageLoadingSkeleton>
    </RecordroomShellWithPalette>
  );
}
