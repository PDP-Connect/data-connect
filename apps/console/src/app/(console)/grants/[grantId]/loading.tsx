// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { TitledDetailLoadingSkeleton } from "../../components/titled-detail-loading.tsx";

/** Route-level loading state for one app's page: the way back to Apps and a title bar. */
export default function AppPageLoading() {
  return (
    <RecordroomShellWithPalette>
      <TitledDetailLoadingSkeleton breadcrumbs={[{ href: "/grants", label: "Apps" }]} label="the app" />
    </RecordroomShellWithPalette>
  );
}
