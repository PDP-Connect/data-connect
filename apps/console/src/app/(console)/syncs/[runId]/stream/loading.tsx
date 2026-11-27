// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { TitledDetailLoadingSkeleton } from "../../../components/titled-detail-loading.tsx";

/**
 * Loading state for the sign-in helper. It is not the run page: its trail starts at Data sources
 * (the source's name is not known yet) and it shows one card, the one the helper opens with.
 */
export default function SignInHelperLoading() {
  return (
    <RecordroomShellWithPalette>
      <TitledDetailLoadingSkeleton breadcrumbs={[{ href: "/sources", label: "Data sources" }]} label="the sign-in page" mark />
    </RecordroomShellWithPalette>
  );
}
