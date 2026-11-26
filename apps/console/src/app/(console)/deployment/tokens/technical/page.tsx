// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  buttonVariants,
  IcTimestamp,
} from "@pdpp/brand-react"
import { CopyButton } from "@pdpp/operator-ui/components/copy-button"
import { Callout, PageHeader } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import {
  buildOwnerBootstrapExamples,
  takeOwnerBootstrapFlow,
} from "../../../lib/operator-bootstrap.ts"
import {
  getReferencePublicOrigin,
} from "../../../lib/owner-token.ts"

export const dynamic = "force-dynamic"

interface Params {
  error?: string
  flow?: string
  notice?: string
  reproduce?: string
}

type FlowState = NonNullable<ReturnType<typeof takeOwnerBootstrapFlow>>
type FlowExamples = NonNullable<
  Awaited<ReturnType<typeof buildOwnerBootstrapExamples>>
>
type ReproduceFormat = "curl" | "cli"

function InlineError({ prefix, message }: { message: string; prefix: string }) {
  return (
    <p className="pdpp-caption mb-4 text-destructive">
      <span className="font-medium text-destructive">{prefix}:</span>{" "}
      <span>{message}</span>
    </p>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="pdpp-caption overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
      <code>{children}</code>
    </pre>
  )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function OwnerAgentOnboardingCard({ entrypoint }: { entrypoint: string }) {
  const command = [
    "pdpp owner-agent onboard",
    shellQuote(entrypoint),
    "--client-name",
    shellQuote("local assistant"),
  ].join(" ")
  return (
    <section className="mb-6 border-b border-border/70 pb-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <p className="pdpp-eyebrow text-muted-foreground">
            Recommended owner-agent path
          </p>
          <h2 className="pdpp-title mt-1 text-foreground">
            Let the local agent complete onboarding
          </h2>
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Use this for a trusted local agent. The agent starts from the public
            entrypoint, opens the browser approval flow, and writes the owner
            credential directly to its local state. No bearer needs to be pasted
            into chat or copied out of the dashboard.
          </p>
        </div>
        <Link
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href="/deployment"
        >
          Review deployment metadata
        </Link>
      </div>
      <div className="mt-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <CodeBlock>{command}</CodeBlock>
        </div>
        <CopyButton
          ariaLabel="Copy owner-agent onboarding command"
          value={command}
        />
      </div>
      <p className="pdpp-caption mt-3 text-muted-foreground">
        The CLI stores the credential under{" "}
        <code className="font-mono">
          ~/.pdpp/owner-agents/&lt;host&gt;.json
        </code>
        . The assistant can read the top-level{" "}
        <code className="font-mono">access_token</code> for owner-level REST
        reads and should not send it to <code className="font-mono">/mcp</code>.
      </p>
    </section>
  )
}

/**
 * Single card that holds both the issuance form and the issued-token result.
 * SLVP convention (GitHub/Stripe/Vercel/Linear) — operator's eye stays on one
 * surface across the create-then-copy transition.
 */
function TranscriptStep({
  index,
  method,
  path,
  body,
}: {
  index: number
  method: string
  path: string
  body?: string
}) {
  return (
    <li>
      <div className="pdpp-caption mb-1 inline-flex items-baseline gap-2 text-muted-foreground">
        <span className="font-mono text-foreground">
          {index}. {method} {path}
        </span>
      </div>
      {body ? <CodeBlock>{body}</CodeBlock> : null}
    </li>
  )
}

function Transcript({ flow }: { flow: FlowState }) {
  const start = JSON.stringify({ client_id: flow.clientId }, null, 2)
  const approve = JSON.stringify({ user_code: flow.userCode }, null, 2)
  const exchange = JSON.stringify(
    {
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    null,
    2
  )
  return (
    <ol className="space-y-4">
      <TranscriptStep
        body={start}
        index={1}
        method="POST"
        path="/oauth/device_authorization"
      />
      <TranscriptStep
        body={approve}
        index={2}
        method="POST"
        path="/device/approve"
      />
      <TranscriptStep
        body={exchange}
        index={3}
        method="POST"
        path="/oauth/token"
      />
    </ol>
  )
}

function IntrospectResult({ flow }: { flow: FlowState }) {
  if (!flow.introspection) {
    return (
      <p className="pdpp-caption text-muted-foreground">
        This token was not checked.
      </p>
    )
  }
  return (
    <div>
      <div className="pdpp-caption mb-1 text-muted-foreground">
        POST /introspect · checked{" "}
        {flow.introspectedAt ? (
          <IcTimestamp value={flow.introspectedAt} />
        ) : (
          "just now"
        )}
      </div>
      <CodeBlock>{JSON.stringify(flow.introspection, null, 2)}</CodeBlock>
    </div>
  )
}

function ReproduceToggle({
  flowId,
  format,
}: {
  flowId: string
  format: ReproduceFormat
}) {
  const base = `/deployment/tokens?flow=${encodeURIComponent(flowId)}`
  return (
    <div className="pdpp-caption inline-flex gap-1 rounded-md border border-border p-0.5">
      <Link
        className={`rounded px-2 py-0.5 ${format === "curl" ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        href={`${base}&reproduce=curl`}
        prefetch={false}
      >
        curl
      </Link>
      <Link
        className={`rounded px-2 py-0.5 ${format === "cli" ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        href={`${base}&reproduce=cli`}
        prefetch={false}
      >
        pdpp CLI
      </Link>
    </div>
  )
}

function ReproduceBlock({
  examples,
  format,
}: {
  examples: FlowExamples
  format: ReproduceFormat
}) {
  if (format === "cli") {
    return (
      <div className="space-y-3">
        <CodeBlock>{examples.cliLogin}</CodeBlock>
        <CodeBlock>{examples.cliIntrospect}</CodeBlock>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <CodeBlock>{examples.startCurl}</CodeBlock>
      <CodeBlock>{examples.approveCurl}</CodeBlock>
      <CodeBlock>{examples.exchangeCurl}</CodeBlock>
      <CodeBlock>{examples.introspectCurl}</CodeBlock>
      <CodeBlock>{examples.ownerReadExample}</CodeBlock>
    </div>
  )
}

function InlineNotice({ message }: { message: string }) {
  return <p className="pdpp-caption mb-4 text-muted-foreground">{message}</p>
}

// Owner bearers and the routine MCP scoped-grant flow are two separate paths
// with two separate audiences. Tokens issued here cover the whole RS read
// surface under the operator's identity — fine for a CLI you wrote yourself,
// a backup script you run from your laptop, or a trusted local agent that
// acts on the operator's behalf. They are explicitly the wrong shape for
// ordinary MCP clients (Claude, ChatGPT, third-party agents); the hosted
// MCP endpoint rejects owner bearers by design.
function OwnerScopeCallout() {
  return (
    <Callout
      className="mb-6"
      title="Use this for operator and trusted-agent access only"
      tone="warning"
    >
      <p className="pdpp-caption text-callout-warning-fg/80">
        Owner-agent credentials are owner bearers — they grant the operator's
        full read access to <code className="font-mono">/v1/*</code>. Use them
        for the operator themselves, for CLI tools and scripts you wrote, and
        for trusted local agents that run on your behalf.
      </p>
      <p className="pdpp-caption mt-2 text-callout-warning-fg/80">
        Ordinary MCP clients (Claude, ChatGPT, third-party agents) should
        connect through the OAuth scoped-grant flow at{" "}
        <code className="font-mono">/mcp</code>. That path is documented in the{" "}
        <Link className="underline-offset-2 hover:underline" href="/connect">
          connect page
        </Link>
        . <code className="font-mono">/mcp</code> rejects owner bearers on
        purpose.
      </p>
    </Callout>
  )
}

/**
 * Per-client token drilldown, shown only when a client has more than one
 * active token. Lists each token with its issued/expiry facts and a per-token
 * revoke that targets exactly that bearer (not the whole client). The
 * `token_id_public` is a non-reversible digest, never a usable bearer.
 */
function FlowInspector({
  flow,
  examples,
  format,
}: {
  flow: FlowState
  examples: FlowExamples | null
  format: ReproduceFormat
}) {
  return (
    <details className="rounded-md border border-border bg-card/30">
      <summary className="cursor-pointer select-none px-4 py-3 font-medium text-sm">
        Show manual bearer wire details
        <span className="pdpp-caption ml-2 text-muted-foreground">
          (real RFC 8628 wire — inspect, debug, or replay outside the dashboard)
        </span>
      </summary>
      <div className="space-y-6 border-border/70 border-t p-5">
        {flow.lastError ? (
          <InlineError message={flow.lastError} prefix="Last action error" />
        ) : null}

        <section>
          <h3 className="pdpp-eyebrow mb-3">Wire transcript</h3>
          <Transcript flow={flow} />
        </section>

        <section>
          <h3 className="pdpp-eyebrow mb-3">Verify</h3>
          <IntrospectResult flow={flow} />
        </section>

        {examples ? (
          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="pdpp-eyebrow">Reproduce out-of-band</h3>
              <ReproduceToggle flowId={flow.flowId} format={format} />
            </div>
            <ReproduceBlock examples={examples} format={format} />
          </section>
        ) : null}
      </div>
    </details>
  )
}

export default async function DeploymentTokensPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const params = await searchParams
  const flow = params.flow ? takeOwnerBootstrapFlow(params.flow) : null
  const examples = flow ? await buildOwnerBootstrapExamples(flow) : null
  const error = params.error ?? null
  const notice = params.notice ?? null
  const format: ReproduceFormat = params.reproduce === "cli" ? "cli" : "curl"
  const entrypoint = await getReferencePublicOrigin()


  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            href="/deployment"
          >
            Server
          </Link>
        }
        breadcrumbs={[
          { href: "/deployment", label: "Server" },
          { label: "Tokens for scripts and tools" },
        ]}
        description="For scripts and tools that read your data without signing in."
        title="Tokens for scripts and tools"
      />

      {error ? (
        <div className="mb-4">
          <p className="text-[13px] text-destructive">
            This could not be done. Try again.
          </p>
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground">
              Details
            </summary>
            <p className="break-all font-mono text-[12px] text-muted-foreground">
              {error}
            </p>
          </details>
        </div>
      ) : null}
      {notice === "revoked" ? (
        <InlineNotice message="Access token revoked." />
      ) : null}
      {notice === "token_revoked" ? (
        <InlineNotice message="Access token revoked. The other access tokens still work." />
      ) : null}
      {notice === "renamed" ? (
        <InlineNotice message="Access token renamed." />
      ) : null}

      <Link className="underline" href="/deployment/tokens">Create and manage tokens</Link>

      <details className="mt-6 border-t border-border/70 pt-4">
        <summary className="min-h-11 cursor-pointer text-[13px] font-medium text-muted-foreground">
          Details
        </summary>
        <div className="grid gap-5 border-b border-border/70 pb-5">
          <OwnerAgentOnboardingCard entrypoint={entrypoint} />
          <OwnerScopeCallout />
          <section>
            <h3 className="pdpp-eyebrow mb-2">Manual/debug bearer</h3>
            <p className="pdpp-caption text-muted-foreground">
              Use this for debugging a script you control or inspecting the
              sign-in steps. Each access token is a freshly registered OAuth
              client. Revoke it to remove that client and its active
              credentials.
            </p>
          </section>
          {flow ? (
            <FlowInspector examples={examples} flow={flow} format={format} />
          ) : null}
        </div>
      </details>
    </RecordroomShellWithPalette>
  )
}
