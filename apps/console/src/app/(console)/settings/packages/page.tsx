// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { unstable_rethrow } from "next/navigation";
import { SupportCopy } from "../../components/support-copy.tsx";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@pdpp/brand-react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { readAddSourceCatalog } from "../../sources/add/add-source-catalog-read.ts";
import { PackageTable } from "./package-table.tsx";
import { buildPackageRows, packagesCopy } from "./package-rows-model.ts";

export const metadata: Metadata = { title: packagesCopy.heading };
export const dynamic = "force-dynamic";

export default async function DataSourcePackagesPage() {
  let rows: ReturnType<typeof buildPackageRows> = [];
  let error: string | null = null;
  try { rows = buildPackageRows(await readAddSourceCatalog()); }
  catch (cause) { unstable_rethrow(cause); error = cause instanceof Error ? cause.message : String(cause); }
  return (
    <RecordroomShellWithPalette>
      <div className="mx-auto grid min-w-0 w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader title={packagesCopy.heading} description="Each service has its own small piece of DataConnect. An update here applies to every account of that service." />
        {error ? <div role="status"><p>Data source updates could not be loaded.</p><Link className={buttonVariants()} href="/settings/packages">Try again</Link><SupportCopy details={error} /></div> : <PackageTable rows={rows} />}
      </div>
    </RecordroomShellWithPalette>
  );
}
