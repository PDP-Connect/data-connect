// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { TitledDetailLoadingSkeleton } from "../../../components/titled-detail-loading.tsx";

/** Route-level loading state for "Connect <service>": the trail to it and a title bar with the service mark. */
export default function ConnectServiceLoading() {
  return (
    <RecordroomShellWithPalette>
      <TitledDetailLoadingSkeleton
        breadcrumbs={[{ href: "/", label: "Home" }, { href: "/sources", label: "Data sources" }, { href: "/sources/add", label: "Add a data source" }]}
        label="the connection page"
        mark
      />
    </RecordroomShellWithPalette>
  );
}
