// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buttonVariants } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { RecordroomShellWithPalette } from "../components/recordroom-shell-with-palette.tsx";
import { UNKNOWN_APP_NAME } from "./app-access.ts";
import { AppsGroups } from "./apps-groups.tsx";
import { denyPendingGroupAction } from "./deny-pending-group-action.ts";
import { loadApps } from "./load-apps.ts";
import { PendingApprovalRow } from "./pending-approval-row.tsx";
export const dynamic = "force-dynamic";
export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string; approval_error?: string }>;
}) {
  const query = await searchParams;
  const demo = process.env.NODE_ENV === "production" ? undefined : query.demo;
  async function denyPracticeAction(_formData: FormData) {
    "use server";
  }
  const { apps, approvals } = await loadApps(demo);
  const waiting = new Map<string, typeof approvals>();
  for (const approval of approvals) {
    const app = apps.find((item) => item.state !== "waiting" && item.clientIds.includes(approval.client_id || ""));
    const key = app ? JSON.stringify(app.clientIds) : approval.client_id || approval.approval_id;
    waiting.set(key, [...(waiting.get(key) || []), approval]);
  }
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants()} href="/connect">
            Connect an app
          </Link>
        }
        title="Apps"
      />
      <p className="mb-6 text-muted-foreground">Assistants and other apps you have allowed to read your data.</p>
      {query.approval_error ? (
        <p role="alert">The request could not be updated. Review the request and try again.</p>
      ) : null}
      {apps.length === 0 && approvals.length === 0 ? (
        <Section title="No app can read your data yet.">
          <p>Connect an assistant such as ChatGPT or Claude, and it can answer questions from your own data.</p>
          <Link className={buttonVariants()} href="/connect">
            Connect an app
          </Link>
        </Section>
      ) : (
        <AppsGroups
          apps={apps}
          demo={demo}
          waiting={[...waiting.entries()].map(([key, requests]) => {
            const approval = requests[0]!;
            const app = apps.find((item) => item.clientIds.includes(approval.client_id || ""));
            return {
              name: app?.name || UNKNOWN_APP_NAME,
              place: app?.place || "",
              node: (
                <PendingApprovalRow
                  appName={app?.name || UNKNOWN_APP_NAME}
                  approval={approval}
                  denyAction={demo ? denyPracticeAction : denyPendingGroupAction}
                  key={key}
                  place={app?.place}
                  requests={requests}
                  reviewHref={demo ? "/consent?demo=one" : undefined}
                />
              ),
            };
          })}
        />
      )}
      <Link className="mt-6 inline-block text-[13px] text-muted-foreground" href="/grants/technical">
        Technical details
      </Link>
    </RecordroomShellWithPalette>
  );
}
