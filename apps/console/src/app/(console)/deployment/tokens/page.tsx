// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { SupportCopy } from "../../components/support-copy.tsx";
import { IcButton, IcInput, buttonVariants } from "@pdpp/brand-react"
import { PageHeader } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { RecordroomShellWithPalette } from "../../components/recordroom-shell-with-palette.tsx"
import { takeOwnerBootstrapFlow } from "../../lib/operator-bootstrap.ts"
import { issueOwnerTokenAction } from "./actions.ts"
import { loadTokenGroups } from "./token-data.ts"
import { CopyButton as LabeledCopyButton } from "../../settings/on-card.tsx"
import { PlainTokenList } from "./plain-token-list.tsx"
import {
  buildTokenPractice,
  tokenGroups,
  type TokenGroup,
} from "./token-model.ts"
import { settingsTrail } from "../../settings/settings-trail.ts"
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
    try { groups = await loadTokenGroups(); }
    catch (cause) { unstable_rethrow(cause); groups = []; inventoryFailed = true; }
  }
  const created = practice?.created ?? flow?.token
  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6">
        <PageHeader breadcrumbs={settingsTrail("Tokens for scripts and tools")} title="Tokens for scripts and tools" />
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
            <h2>{flow?.name || (practice ? "Backup script" : "Your new token")}</h2>
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border p-3">
                {created}
              </pre>
              <LabeledCopyButton label="Copy token" text={created} />
            </div>
            <p>Copy it now. You won’t see it again.</p>
            <Link className={buttonVariants({ variant: "default" })} href="/deployment/tokens">
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
