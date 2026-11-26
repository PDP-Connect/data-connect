// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { RecordroomShellWithPalette } from "../components/recordroom-shell-with-palette.tsx";
import { AppAccessList } from "./app-access-list.tsx";
import { loadApps } from "./load-apps.ts";
import { PendingApprovalRow } from "./pending-approval-row.tsx";
import { denyPendingApprovalAction } from "./pending-actions.ts";
import { UNKNOWN_APP_NAME } from "./app-access.ts";
export const dynamic = "force-dynamic";
export default async function AppsPage({ searchParams }: { searchParams: Promise<{ demo?: string; approval_error?: string }> }) {
  const query = await searchParams;
  const { apps, approvals } = await loadApps(query.demo);
  const reading = apps.filter((app) => app.state === "reading");
  const stopped = apps.filter((app) => app.state === "stopped").sort((a, b) => (b.stoppedAt || "").localeCompare(a.stoppedAt || ""));
  return <RecordroomShellWithPalette>
    <PageHeader title="Apps" />
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><p className="text-muted-foreground">Assistants and other apps you have allowed to read your data.</p><Link href="/connect">Connect an app</Link></div>
    {query.approval_error ? <p role="alert">The request could not be updated. Try again.</p> : null}
    {apps.length === 0 && approvals.length === 0 ? <Section title="No app can read your data yet."><p>Connect an assistant such as ChatGPT or Claude, and it can answer questions from your own data.</p><Link href="/connect">Connect an app</Link></Section> : <>
      {approvals.length > 0 ? <Section id="pending-approvals" title="Waiting for you"><ul>{approvals.map((approval) => <li key={approval.approval_id}><PendingApprovalRow approval={approval} appName={apps.find((app) => app.clientIds.includes(approval.client_id || ""))?.name || UNKNOWN_APP_NAME} denyAction={denyPendingApprovalAction} /></li>)}</ul></Section> : null}
      <Section title={`Can read your data${reading.length > 5 ? ` · ${reading.length}` : ""}`}><AppAccessList apps={reading} demo={query.demo} /></Section>
      {stopped.length ? <Section title="No longer have access"><AppAccessList apps={stopped} demo={query.demo} stopped /></Section> : null}
    </>}
    <Link className="mt-6 inline-block text-[13px] text-muted-foreground" href="/grants/technical">Technical details</Link>
  </RecordroomShellWithPalette>;
}
