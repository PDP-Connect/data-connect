// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { readAddSourceCatalog } from "./add-source-catalog-read.ts";
import { AddSourceHeader } from "./add-source-header.tsx";
import { isDeterministicSourcesReadError } from "../read-error-classification.ts";
import { ADD_SOURCE_COPY, buildAddSourceList } from "./add-source-list-model.ts";
import { AddSourceList, AddSourceLoadFailed } from "./add-source-list.tsx";
import { setupErrorCopy } from "./setup-error-copy.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  error?: string;
  source_q?: string;
}

export default async function AddSourcePage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let model: ReturnType<typeof buildAddSourceList>;
  let notFresh: Awaited<ReturnType<typeof readAddSourceCatalog>>["catalogNotFresh"];
  try {
    const read = await readAddSourceCatalog();
    notFresh = read.catalogNotFresh;
    model = buildAddSourceList(read);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError || isDeterministicSourcesReadError(err)) {
      return (
        <RecordroomShellWithPalette>
          <AddSourceHeader />
          <AddSourceLoadFailed />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }
  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  const setupError = setupErrorCopy(typeof params.error === "string" ? params.error : undefined);
  return (
    <RecordroomShellWithPalette>
      <AddSourceHeader />
      {setupError ? <p className="pdpp-caption py-2 text-muted-foreground" role="alert">{setupError}</p> : null}
      <AddSourceList model={model} notFresh={notFresh} query={sourceQuery} />
    </RecordroomShellWithPalette>
  );
}
