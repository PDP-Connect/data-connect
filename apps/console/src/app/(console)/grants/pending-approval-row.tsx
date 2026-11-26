"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import { useState } from "react";
import Link from "next/link";
import type { PendingApproval } from "../lib/ref-client.ts";
import { appSourceName } from "./app-access.ts";

/** Queue row only. It can route to review or deny; grant issuance is absent. */
export function PendingApprovalRow({
  approval,
  appName,
  place,
  reviewHref,
  denyAction,
}: {
  approval: PendingApproval;
  appName: string;
  place?: string;
  reviewHref?: string;
  connectorIcons?: Readonly<Record<string, import("@pdpp/brand-react").ConnectorIconLike | null | undefined>>;
  denyAction: (formData: FormData) => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-foreground">{appName}</p>
        {place ? <p className="text-[13px] text-muted-foreground">{place}</p> : null}
        <p className="mt-1 text-[13px] text-muted-foreground">
          {approval.grant_preview?.source ? `Wants to read ${appSourceName(approval.grant_preview.source)}` : "Wants to read your data"}
        </p>
        <IcTimestamp value={approval.created_at} />
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={reviewHref || `/grants/approvals/${encodeURIComponent(approval.approval_id)}`}
        >
          Review
        </Link>
        {!confirming ? <IcButton variant="ghost" onClick={() => setConfirming(true)}>Don't allow</IcButton> : <div role="alertdialog" aria-label={`Don't allow ${appName}?`}>
          <div className="mt-2 rounded-md border border-border-strong p-3">
            <p className="pdpp-caption text-foreground">
              Don't allow {appName}? It will not get access to your data.
            </p>
            <form action={denyAction} className="mt-3">
              <input name="kind" type="hidden" value={approval.kind} />
              <input name="approval_id" type="hidden" value={approval.approval_id} />
              <input name="deny_confirmation" type="hidden" value="yes" />
              <IcButton size="sm" type="submit" variant="destructive">Don't allow</IcButton>
            </form>
          </div>
          <IcButton variant="ghost" onClick={() => setConfirming(false)}>Cancel</IcButton>
        </div>}
      </div>
    </div>
  );
}
