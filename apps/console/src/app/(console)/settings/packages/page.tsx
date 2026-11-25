// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import type { Metadata } from "next";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { readAddSourceCatalog } from "../../sources/add/add-source-catalog-read.ts";
import { PackageTable } from "./package-table.tsx";
import { buildPackageRows, packagesCopy } from "./package-rows-model.ts";

export const metadata: Metadata = { title: packagesCopy.heading };
export const dynamic = "force-dynamic";

export default async function DataSourcePackagesPage() {
  const read = await readAddSourceCatalog();
  const rows = buildPackageRows(read);
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader title={packagesCopy.heading} />
        <PackageTable rows={rows} />
      </main>
    </RecordroomShellWithPalette>
  );
}
