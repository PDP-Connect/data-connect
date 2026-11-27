"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import Link from "next/link";
import { Button } from "@pdpp/operator-ui/ui/button";
import { useState } from "react";
import type { PendingApproval } from "../lib/ref-client.ts";
import { appSourceName } from "./app-access.ts";

/** Queue row only. It can route to review or deny; grant issuance is absent. */
export function PendingApprovalRow({
  approval,
  appName,
  place,
  reviewHref,
  denyAction,
  requests = [approval],
}: {
  approval: PendingApproval;
  requests?: PendingApproval[];
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
        <p className="font-medium text-[15px] text-foreground">
          {appName}
          {requests.length > 1 ? ` is waiting for your answer · ${requests.length} requests` : ""}
        </p>
        {place ? <p className="text-[13px] text-muted-foreground">{place}</p> : null}
        <p className="mt-1 text-[13px] text-muted-foreground">
          {approval.grant_preview?.source
            ? `Wants to read ${appSourceName(approval.grant_preview.source)}`
            : "Wants to read your data"}
        </p>
        <IcTimestamp value={approval.created_at} />
        {requests.length > 1 ? <Link className="ml-3 text-primary" href={reviewHref || `/grants/approvals/${encodeURIComponent(requests[1]?.approval_id || approval.approval_id)}`}>{requests.length-1} more requests</Link> : null}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <Link
          className={buttonVariants()}
          href={reviewHref || `/grants/approvals/${encodeURIComponent(approval.approval_id)}`}
        >
          Review
        </Link>
        {confirming ? (
          <div aria-label={`Don't allow ${appName}?`} role="alertdialog">
            <div className="mt-2 rounded-md border border-border-strong p-3">
              <p className="pdpp-caption text-foreground">
                Don't allow {appName}? It will not get access to your data.
              </p>
              <form action={denyAction} className="mt-3 flex flex-wrap gap-2">
                <input
                  name="requests"
                  type="hidden"
                  value={JSON.stringify(
                    requests.map((request) => ({ approvalId: request.approval_id, kind: request.kind }))
                  )}
                />
                <input name="kind" type="hidden" value={approval.kind} />
                <input name="approval_id" type="hidden" value={approval.approval_id} />
                <input name="deny_confirmation" type="hidden" value="yes" />
                <IcButton size="sm" type="submit" variant="destructive">
                  Don't allow
                </IcButton>
                <IcButton onClick={() => setConfirming(false)} size="sm" type="button" variant="ghost">
                  Cancel
                </IcButton>
              </form>
            </div>
          </div>
        ) : (
          <Button onClick={() => setConfirming(true)} size="sm" type="button" variant="link">
            Don't allow
          </Button>
        )}
      </div>
    </div>
  );
}
