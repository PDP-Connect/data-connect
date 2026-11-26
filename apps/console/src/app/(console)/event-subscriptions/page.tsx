// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { SupportCopy } from "../components/support-copy.tsx";
import { PageHeader } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { RecordroomShellWithPalette } from "../components/recordroom-shell-with-palette.tsx"
import { appNamesByClientId } from "../grants/app-access.ts"
import {
  getClientEventSubscription,
  listClientEventSubscriptions,
  listGrants,
  listOwnerIssuedClients,
  type ClientEventSubscriptionSummary,
  type ClientEventSubscriptionDetail,
} from "../lib/ref-client.ts"
import { WebhookList, WebhookDetail } from "./webhook-view.tsx"
import { buildWebhookPractice } from "./webhook-model.ts"
export const dynamic = "force-dynamic"
export const metadata = { title: "Webhooks" }
export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    demo?: string
    peek?: string
    disable_error?: string
    client_id?: string
    grant_id?: string
    status?: string
  }>
}) {
  const params = await searchParams
  const practice =
    process.env.NODE_ENV !== "production" && params.demo
      ? buildWebhookPractice(params.demo)
      : null
  let rows: ClientEventSubscriptionSummary[]
  let peek: ClientEventSubscriptionDetail | null = null
  let names: Record<string, string> = {}
  let failed = false
  let loadError = "Webhooks could not be loaded"
  if (practice) {
    rows = practice
    names = Object.fromEntries(
      practice.map((row, index) => [
        row.client_id,
        ["Reading list", "Calendar", "Backup tool", "Notes"][index]!,
      ])
    )
    if (params.peek) {
      const row = practice.find(row => row.subscription_id === params.peek)
      if (row)
        peek = {
          ...row,
          callback_url: "https://updates.example/changes",
          recent_attempts: [],
          scope: null,
          subject_id: "practice",
        }
    }
  } else {
    try {
      const [list, grants, clients] = await Promise.all([
        listClientEventSubscriptions({
          client_id: params.client_id,
          grant_id: params.grant_id,
          status: params.status,
        }),
        listGrants({ limit: 200 }).catch(() => ({ data: [] })),
        listOwnerIssuedClients().catch(() => ({ data: [] })),
      ])
      rows = list.data
      names = Object.fromEntries(appNamesByClientId(grants.data, clients.data))
      if (params.peek)
        peek = await getClientEventSubscription(params.peek).catch(() => null)
    } catch (error) {
      rows = []
      failed = true
      loadError = error instanceof Error ? error.message : String(error)
    }
  }
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader
          title="Webhooks"
          description="An app can ask to be told when your data changes. It gives DataConnect an address to send a short message to."
        />
        <form
          action="/event-subscriptions"
          method="get"
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="webhook-status">Status</label>
          <select
            id="webhook-status"
            name="status"
            defaultValue={params.status || ""}
            className="min-h-11 rounded-md border border-border bg-background px-3"
          >
            <option value="">All</option>
            <option value="active">Working</option>
            <option value="pending_verification">
              Waiting for confirmation
            </option>
            <option value="disabled">Stopped</option>
            <option value="disabled_failure">Delivery failed</option>
            <option value="disabled_revoked">Access removed</option>
          </select>
          <button type="submit" className="min-h-11 px-3 underline">
            Apply
          </button>
        </form>
        {failed ? (
          <div>
          <p>
            This could not be loaded.{" "}
            <Link href="/event-subscriptions">Try again</Link>.
          </p>
          <SupportCopy details={loadError} />
          </div>
        ) : (
          <WebhookList rows={rows} names={names} practice={Boolean(practice)} />
        )}
        {peek ? (
          <WebhookDetail
            row={peek}
            name={names[peek.client_id]}
            error={params.disable_error}
            practice={Boolean(practice)}
            returnTo="list"
          />
        ) : null}
      </main>
    </RecordroomShellWithPalette>
  )
}
