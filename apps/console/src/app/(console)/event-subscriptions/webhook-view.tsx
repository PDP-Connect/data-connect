"use client"
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { SupportCopy } from "../components/support-copy.tsx";
import { IcButton, IcInput } from "@pdpp/brand-react"
import Link from "next/link"
import { useState } from "react"
import type {
  ClientEventSubscriptionSummary,
  ClientEventSubscriptionDetail,
} from "../lib/ref-client.ts"
import { pendingApprovalAppName } from "../grants/app-access.ts"
import { disableSubscriptionAction } from "./disable-action.ts"
import { webhookHost, webhookNotice, type WebhookScope, webhookState } from "./webhook-model.ts"
export function WebhookList({
  rows,
  names,
  practice = false,
  peek,
  detailError,
}: {
  peek?: ClientEventSubscriptionDetail | null;
  detailError?: string;
  rows: Array<ClientEventSubscriptionSummary & { scope?: WebhookScope }>
  names: Record<string, string>
  practice?: boolean
}) {
  if (!rows.length) return <p>No app has asked for this.</p>
  return (
    <ul className="divide-y divide-border/70 border-y border-border/70">
      {rows.map(row => (
        <li className="py-4" key={row.subscription_id}>
          <Link
            className="grid gap-1"
            href={
              practice
                ? `/event-subscriptions?demo=states&peek=${encodeURIComponent(row.subscription_id)}`
                : `/event-subscriptions/${encodeURIComponent(row.subscription_id)}`
            }
          >
            <p>{pendingApprovalAppName(names[row.client_id])}</p>
            <p className="text-sm text-muted-foreground">{webhookHost(row.callback_host)}</p>
            <p className="text-sm text-muted-foreground">
              {webhookNotice(row.scope)}
            </p>
            <p className="text-sm text-muted-foreground">{webhookState(row)}</p>
          </Link>
          {peek?.subscription_id === row.subscription_id ? <WebhookDetail row={peek} name={names[row.client_id]} error={detailError} practice={practice} returnTo="list" /> : null}
        </li>
      ))}
    </ul>
  )
}
export function WebhookDetail({
  row,
  name,
  error,
  practice = false,
  returnTo = "detail",
}: {
  row: ClientEventSubscriptionDetail
  name?: string
  error?: string
  practice?: boolean
  returnTo?: "detail" | "list"
}) {
  const [confirm, setConfirm] = useState(false)
  const canStop =
    row.status === "active" || row.status === "pending_verification"
  return (
    <section className="grid gap-4">
      <h2>{pendingApprovalAppName(name)}</h2>
      <p>{webhookState(row)}</p>
      <p className="break-all text-sm text-muted-foreground">
        {row.callback_url}
      </p>
      <p>{webhookNotice(row.scope)}</p>
      {canStop ? (
        confirm ? (
          <form
            action={disableSubscriptionAction}
            className="grid gap-3"
            aria-label="Stop messages"
          >
            <input
              name="subscription_id"
              type="hidden"
              value={row.subscription_id}
            />
            <input name="return_to" type="hidden" value={returnTo} />
            <label className="grid gap-1">
              Reason (optional)
              <IcInput name="reason" />
              <span className="text-sm text-muted-foreground">
                Keep the reason short.
              </span>
            </label>
            <label className="flex gap-2">
              <input
                type="checkbox"
                name="confirm_disable"
                value="yes"
                required
              />
              I understand this stops messages to this address. The app can turn
              them back on.
            </label>
            <div className="flex gap-2">
              <IcButton disabled={practice} type="submit">
                Stop
              </IcButton>
              <IcButton variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </IcButton>
            </div>
          </form>
        ) : (
          <IcButton
            className="w-fit"
            variant="ghost"
            onClick={() => setConfirm(true)}
          >
            Stop
          </IcButton>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          {row.status === "disabled_revoked"
            ? "Its access was removed. The app needs new access and a new webhook."
            : row.status === "deleted"
              ? "This webhook was deleted. The app needs to set up a new one."
              : row.status === "disabled_failure"
                ? "Messages stopped after repeated delivery failures. The app can turn them back on after fixing its address."
                : "Messages are stopped. The app can turn them back on."}
        </p>
      )}
      {error ? (
        <div role="status">
          <p>This could not be stopped. Try again.</p>
          <SupportCopy details={error} />
        </div>
      ) : null}
      <h3>Recent deliveries</h3>
      {row.recent_attempts.length ? (
        <ol className="divide-y divide-border">
          {row.recent_attempts.map(attempt => (
            <li className="grid gap-1 py-3" key={attempt.attempt_id}>
              <p>
                {attempt.ok ? "Delivered" : "The message did not arrive"} ·{" "}
                {new Date(attempt.attempted_at).toLocaleString()}
              </p>
              {!attempt.ok ? (
                <SupportCopy details={JSON.stringify(attempt)} />
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No deliveries yet.</p>
      )}
    </section>
  )
}
