// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";

/** Route-level loading state for sign-in apps for data sources: its trail, its title and the rows it shows. */
export default function SignInAppsLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Sign-in apps for data sources" }]} framed label="sign-in apps" shape="list" title="Sign-in apps for data sources" />
    </RecordroomShellWithPalette>
  );
}
