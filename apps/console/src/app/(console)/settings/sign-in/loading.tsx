// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";

/** Route-level loading state for Password and sign-in: its trail, its title and the rows it shows. */
export default function PasswordLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Password and sign-in" }]} framed label="password and sign-in" shape="form" title="Password and sign-in" />
    </RecordroomShellWithPalette>
  );
}
