// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import Link from "next/link";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import type { PendingApproval } from "../lib/ref-client.ts";
import { appSourceName } from "./app-access.ts";

/** Queue row only. It can route to review or deny; grant issuance is absent. */
export function PendingApprovalRow({
  approval,
  appName,
  connectorIcons = {},
  denyAction,
}: {
  approval: PendingApproval;
  appName: string;
  connectorIcons?: Readonly<Record<string, import("@pdpp/brand-react").ConnectorIconLike | null | undefined>>;
  denyAction: (formData: FormData) => void | Promise<void>;
}) {
  const previewStreams = Array.isArray(approval.grant_preview?.streams)
    ? approval.grant_preview.streams.flatMap((stream) => {
        const name = typeof stream === "string" ? stream : stream?.name || "";
        return name ? [name] : [];
      })
    : [];
  const connectorId = approval.grant_preview?.source?.kind === "connector" ? approval.grant_preview.source.connector_id ?? approval.grant_preview.source.id : null;
  return (
    <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-foreground">{appName}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {approval.grant_preview?.source ? `Can read ${appSourceName(approval.grant_preview.source)}` : "Waiting for your choice"}
          {previewStreams.length ? ` · Kinds of records: ${previewStreams.join(", ")}` : ""}
        </p>
        <details className="mt-1">
          <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
          <div className="pdpp-caption flex flex-wrap gap-3 text-muted-foreground">
            <span>{approval.approval_id}</span>
            <IcTimestamp value={approval.created_at} />
            <span>{approval.kind}</span>
            {approval.client_id ? <span>App id: {approval.client_id}</span> : null}
            {connectorId ? <ConnectorMark spacing="after" {...(approval.grant_preview?.source?.connector_id ? { connectorId: approval.grant_preview.source.connector_id } : { sourceId: approval.grant_preview?.source?.id ?? "" })} icon={connectorIcons[connectorId]} name={connectorId} /> : null}
          </div>
        </details>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={`/grants/approvals/${encodeURIComponent(approval.approval_id)}`}
        >
          Review
        </Link>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center rounded-[6px] px-3 text-[13px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Don't allow</summary>
          <div className="mt-2 rounded-md border border-border-strong p-3">
            <p className="pdpp-caption text-foreground">
              {approval.kind === "consent" ? "The app will not get access to your data." : "This device will not get owner access."}
            </p>
            <form action={denyAction} className="mt-3">
              <input name="kind" type="hidden" value={approval.kind} />
              <input name="approval_id" type="hidden" value={approval.approval_id} />
              <input name="deny_confirmation" type="hidden" value="yes" />
              <IcButton size="sm" type="submit" variant="destructive">Don't allow</IcButton>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
}
