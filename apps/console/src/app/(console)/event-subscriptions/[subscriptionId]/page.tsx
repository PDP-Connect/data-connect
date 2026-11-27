// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { notFound } from "next/navigation"
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx"
import {
  getClientEventSubscription,
  listGrants,
  listOwnerIssuedClients,
} from "../../lib/ref-client.ts"
import { appNamesByClientId } from "../../grants/app-access.ts"
import { WebhookDetail } from "../webhook-view.tsx"
export const dynamic = "force-dynamic"
export default async function WebhookPage({
  params,
  searchParams,
}: {
  params: Promise<{ subscriptionId: string }>
  searchParams: Promise<{ disable_error?: string }>
}) {
  const { subscriptionId } = await params
  const query = await searchParams
  const subscription = await getClientEventSubscription(subscriptionId)
  if (!subscription) notFound()
  const [grants, clients] = await Promise.all([
    listGrants({ client_id: subscription.client_id }).catch(() => ({
      data: [],
    })),
    listOwnerIssuedClients().catch(() => ({ data: [] })),
  ])
  const name = appNamesByClientId(grants.data, clients.data).get(
    subscription.client_id
  )
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6">
        <PageHeader title="Webhook" />
        <Link className="underline" href="/event-subscriptions">
          All webhooks
        </Link>
        <WebhookDetail
          row={subscription}
          name={name}
          error={query.disable_error}
        />
      </main>
    </RecordroomShellWithPalette>
  )
}
