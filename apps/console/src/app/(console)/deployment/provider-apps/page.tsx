// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getProviderAppConfig, type ProviderAppConfigGroup } from "../../lib/ref-client.ts";
import { setProviderAppConfigAction } from "./actions.ts";
import { GroupForm } from "./group-form.tsx";
import { settingsTrail } from "../../settings/settings-trail.ts"

export const dynamic = "force-dynamic";

interface PageParams {
  error?: string;
  notice?: string;
}

function InlineError({ message }: { message: string }) {
  return <p className="mb-4 text-[13px] text-destructive">{message}</p>;
}

function InlineNotice({ message }: { message: string }) {
  return <p className="mb-4 text-[13px] text-muted-foreground">{message}</p>;
}

export default async function ProviderAppConfigPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;

  let groups: ProviderAppConfigGroup[] = [];
  try {
    ({ groups } = await getProviderAppConfig());
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader breadcrumbs={settingsTrail("Sign-in apps for data sources")} title="Sign-in apps for data sources" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={settingsTrail("Sign-in apps for data sources")}
        description="These details let data sources start a sign-in with their provider."
        title="Sign-in apps for data sources"
      />

      {params.error ? (
        <div className="mb-4">
          <InlineError message="This could not be saved. Try again." />
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground">Details</summary>
            <p className="break-words font-mono text-[12px] text-muted-foreground">{params.error}</p>
          </details>
        </div>
      ) : null}
      {params.notice === "saved" ? <InlineNotice message="Saved." /> : null}

      {groups.length === 0 ? (
        <p className="py-4 text-[15px] text-muted-foreground">
          No data source needs shared sign-in details right now.
        </p>
      ) : (
        <div className="grid gap-6">
          {groups.map((group) => (
            <GroupForm action={setProviderAppConfigAction} group={group} key={group.identity_group} />
          ))}
        </div>
      )}
    </RecordroomShellWithPalette>
  );
}
