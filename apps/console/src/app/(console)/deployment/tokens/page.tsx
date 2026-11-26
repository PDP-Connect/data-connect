// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { SupportCopy } from "../../components/support-copy.tsx";
import { IcButton, IcInput } from "@pdpp/brand-react"
import { CopyButton } from "@pdpp/operator-ui/components/copy-button"
import { PageHeader } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx"
import { takeOwnerBootstrapFlow } from "../../lib/operator-bootstrap.ts"
import {
  listOwnerClientTokens,
  listOwnerIssuedClients,
} from "../../lib/ref-client.ts"
import { loadOwnerSessionInventory } from "../../settings/owner-sessions-data.ts"
import { issueOwnerTokenAction } from "./actions.ts"
import { PlainTokenList } from "./plain-token-list.tsx"
import {
  buildTokenPractice,
  tokenGroups,
  type TokenGroup,
} from "./token-model.ts"
export const dynamic = "force-dynamic"
export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{
    demo?: string
    flow?: string
    error?: string
    notice?: string
  }>
}) {
  const params = await searchParams
  const practice =
    process.env.NODE_ENV !== "production" && params.demo
      ? buildTokenPractice(params.demo)
      : null
  const flow =
    !practice && params.flow ? takeOwnerBootstrapFlow(params.flow) : null
  let groups: TokenGroup[]
  let inventoryFailed = false
  if (practice)
    groups = tokenGroups(practice.clients, practice.details, practice.owners)
  else {
    const [clients, inventory] = await Promise.all([
      listOwnerIssuedClients(),
      loadOwnerSessionInventory()
        .then(inventory => ({ inventory, failed: false }))
        .catch(() => ({ inventory: null, failed: true })),
    ])
    inventoryFailed = inventory.failed
    const details = Object.fromEntries(
      await Promise.all(
        clients.data.map(
          async client =>
            [
              client.client_id,
              (
                await listOwnerClientTokens(client.client_id).catch(() => ({
                  data: [],
                }))
              ).data,
            ] as const
        )
      )
    )
    groups = tokenGroups(
      clients.data,
      details,
      inventory.inventory?.bearers ?? []
    )
  }
  const created = practice?.created ?? flow?.token
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader title="Tokens for scripts and tools" />
        <p className="text-muted-foreground">
          A token lets a script or tool of yours read all your data without
          signing in. Give one only to something you run yourself. For ChatGPT,
          Claude and other apps, use{" "}
          <Link className="underline" href="/connect">
            Connect an app
          </Link>{" "}
          instead.
        </p>
        {params.error || flow?.lastError ? (
          <div role="status">
            <p>This could not be done. Try again.</p>
            <SupportCopy details={params.error || flow?.lastError || ""} />
          </div>
        ) : null}
        {params.notice ? (
          <p role="status">
            {params.notice === "renamed" ? "Token renamed." : "Token removed."}
          </p>
        ) : null}
        {inventoryFailed ? (
          <p role="status">
            Some tokens could not be loaded. Refresh this page to try again.
          </p>
        ) : null}
        {created ? (
          <section className="grid gap-3">
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border p-3">
                {created}
              </pre>
              <CopyButton ariaLabel="Copy token" value={created} />
            </div>
            <p>Copy it now. You won’t see it again.</p>
            <Link className="min-h-11 py-2 underline" href="/deployment/tokens">
              Done
            </Link>
          </section>
        ) : (
          <form action={issueOwnerTokenAction} className="grid gap-2">
            <label htmlFor="token-name">Name</label>
            <div className="flex flex-wrap gap-2">
              <IcInput
                id="token-name"
                name="name"
                placeholder="Backup script"
                required
              />
              <IcButton disabled={Boolean(practice)} type="submit">
                Create a token
              </IcButton>
            </div>
          </form>
        )}
        <PlainTokenList groups={groups} practice={Boolean(practice)} />
        <Link
          className="min-h-11 py-3 text-sm underline"
          href={`/deployment/tokens/technical${params.flow ? `?flow=${encodeURIComponent(params.flow)}` : ""}`}
        >
          Technical details
        </Link>
      </main>
    </RecordroomShellWithPalette>
  )
}
