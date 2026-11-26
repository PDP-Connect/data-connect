// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcField, IcInput } from "@pdpp/brand-react";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { type CimdClientDocument, type AppAccess, listCimdClientDocuments, listAppAccess } from "../../lib/ref-client.ts";
import { AppAccessList } from "../../grants/app-access-list.tsx";
import { groupGrantAccessByApp } from "../../grants/app-access.ts";
import { needsRemoteAccess } from ".././remote-access.ts";
import { createCimdClientIdentityAction, deleteCimdClientIdentityAction } from ".././actions.ts";

export const dynamic = "force-dynamic";

const TRAILING_SLASH_RE = /\/+$/;

interface PageParams {
  access_removed?: string;
  client_identity?: string;
  demo?: string;
  error?: string;
  notice?: string;
  remove_error?: string;
}

interface SetupEntry {
  body: string;
  label: string;
  title: string;
  value: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(TRAILING_SLASH_RE, "");
}

function buildConnectTargets(origin: string) {
  const base = trimTrailingSlash(origin);
  const mcpUrl = `${base}/mcp`;
  return {
    agentEntrypoint: `${base}/llms.txt`,
    claudeCodeCommand: `claude mcp add --transport http pdpp ${mcpUrl}`,
    codexCommand: `codex mcp add pdpp --url ${mcpUrl}`,
    mcpUrl,
  };
}

function buildCimdCommands(mcpUrl: string, clientId: string) {
  return {
    claudeCodeCimdCommand: `claude mcp add --transport http --client-id ${clientId} pdpp ${mcpUrl}`,
    codexCimdCommand: `codex mcp add pdpp --url ${mcpUrl} --oauth-resource ${mcpUrl} --oauth-client-id ${clientId}`,
  };
}

function CopyRow({ body, label, title, value }: SetupEntry) {
  return (
    <li className="grid gap-2 py-4 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6">
      <div>
        <h3 className="pdpp-title text-foreground">{title}</h3>
        <p className="pdpp-caption mt-1 text-muted-foreground">{body}</p>
      </div>
      {/* P1: desktop = compact single-line pill (items-center, content-hug);
          mobile = column-stack via rr-copy-row__cmd (see components.css).
          items-center keeps the copy icon vertically centered on one line. */}
      <div className="rr-copy-row__cmd flex min-w-0 items-center overflow-hidden rounded-md border border-border/80">
        <code className="rr-copy-row__text pdpp-caption min-w-0 flex-1 overflow-x-auto bg-muted/30 px-3 py-1.5 font-mono text-foreground leading-none">
          {value}
        </code>
        {/* rr-copy-row__btn — desktop: 32px icon tap zone; mobile: ≥44px via CSS */}
        <span className="rr-copy-row__btn flex shrink-0 items-center border-border/80 border-l">
          <CopyButton
            ariaLabel={`Copy ${label}`}
            className="!h-8 !w-8 rounded-none bg-muted/30 hover:bg-muted/60"
            size="md"
            value={value}
          />
        </span>
      </div>
    </li>
  );
}

function InlineNotice({ kind, message }: { kind: "error" | "notice"; message: string }) {
  const tone =
    kind === "error"
      ? "border-destructive/30 bg-destructive/5 text-destructive"
      : "border-border/80 bg-muted/30 text-muted-foreground";
  return <div className={`pdpp-caption rounded-md border px-4 py-2.5 ${tone}`}>{message}</div>;
}

function noticeText(code?: string): string | null {
  if (code === "client_identity_created") {
    return "Identity created.";
  }
  if (code === "client_identity_deleted") {
    return "Identity removed. Access issued through it was also removed.";
  }
  return null;
}

function ClientIdentityForm() {
  return (
    <form action={createCimdClientIdentityAction} className="rounded-md border border-border/80 bg-muted/20 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <IcField htmlFor="cimd-client-name" label="Client name">
          <IcInput defaultValue="Claude Code" id="cimd-client-name" name="client_name" />
        </IcField>
        <IcField htmlFor="cimd-redirect-uri" label="Redirect URI">
          <IcInput
            defaultValue="http://localhost:1455/callback"
            id="cimd-redirect-uri"
            name="redirect_uri"
            placeholder="http://localhost:<port>/callback"
          />
        </IcField>
      </div>
      <div className="mt-3 flex justify-end">
        <IcButton size="sm" type="submit" variant="ghost">
          Create identity
        </IcButton>
      </div>
    </form>
  );
}

function ClientIdentityList({
  identities,
  selectedId,
}: {
  identities: CimdClientDocument[];
  selectedId: string | null;
}) {
  if (!identities.length) {
    return (
      <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
        No client identities yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/70 rounded-md border border-border/80">
      {identities.map((identity) => {
        const selected = identity.document_id === selectedId;
        return (
          <li
            className={`grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] ${selected ? "bg-muted/30" : ""}`}
            key={identity.document_id}
          >
            <div className="min-w-0">
              <div className="pdpp-body font-medium">{identity.client_name ?? "Custom MCP client"}</div>
              <div className="pdpp-caption mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                <code className="max-w-full overflow-x-auto font-mono text-xs">{identity.client_id}</code>
                <span aria-hidden>·</span>
                <span>{identity.redirect_uris[0] ?? "no redirect URI"}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                className={buttonVariants({ size: "sm", variant: selected ? "default" : "ghost" })}
                href={`/connect?client_identity=${encodeURIComponent(identity.document_id)}`}
              >
                {selected ? "Selected" : "Use"}
              </Link>
              <details className="min-w-0">
                <summary className="flex min-h-11 cursor-pointer items-center rounded-[6px] px-3 text-[13px] text-destructive underline-offset-2 hover:bg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Remove identity
                </summary>
                <div className="mt-2 rounded-md border border-border-strong p-3">
                  <p className="pdpp-caption text-foreground">
                    {identity.client_name ?? "This app"} will lose its saved setup and access issued through it will stop working.
                  </p>
                  <form action={deleteCimdClientIdentityAction} className="mt-3">
                    <input name="document_id" type="hidden" value={identity.document_id} />
                    <input name="confirm_delete" type="hidden" value="yes" />
                    <IcButton size="sm" type="submit" variant="destructive">Remove identity</IcButton>
                  </form>
                </div>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SelectedIdentityCommands({
  mcpUrl,
  selected,
  targets,
}: {
  mcpUrl: string;
  selected: CimdClientDocument | null;
  targets: ReturnType<typeof buildConnectTargets>;
}) {
  if (!selected) {
    return null;
  }
  const cimd = buildCimdCommands(mcpUrl, selected.client_id);
  const entries: SetupEntry[] = [
    {
      body: "Default discovery; use this unless the client asks for an explicit client_id.",
      label: "Claude Code default command",
      title: "Claude Code",
      value: targets.claudeCodeCommand,
    },
    {
      body: "Pins this local client to the selected stable metadata URL.",
      label: "Claude Code CIMD command",
      title: "Claude Code + CIMD",
      value: cimd.claudeCodeCimdCommand,
    },
    {
      body: "Default discovery for the hosted MCP endpoint.",
      label: "Codex default command",
      title: "Codex",
      value: targets.codexCommand,
    },
    {
      body: "Pins Codex to the selected stable metadata URL.",
      label: "Codex CIMD command",
      title: "Codex + CIMD",
      value: cimd.codexCimdCommand,
    },
  ];
  return (
    <div className="mt-5">
      <div className="mb-2">
        <p className="pdpp-eyebrow">Selected identity</p>
        <p className="pdpp-caption text-muted-foreground">
          {selected.client_name ?? "Custom MCP client"} · <code className="font-mono">{selected.document_id}</code>
        </p>
      </div>
      <ul className="divide-y divide-border/70 border-border/70 border-y">
        {entries.map((entry) => (
          <CopyRow key={entry.title} {...entry} />
        ))}
      </ul>
    </div>
  );
}

export default async function ConnectPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let origin: string;
  let identities: CimdClientDocument[] = [];
  let registrations: AppAccess[] = [];
  let grantsHaveMore = false;
  let grantsUnavailable = false;
  if (process.env.NODE_ENV !== "production" && (params.demo === "atlas" || params.demo === "empty")) {
    origin = "https://pdpp.example.test";
    if (params.demo === "atlas") {
      registrations = (await (await import("../../grants/grants-demo-data.ts")).createAppAccessDemoDataSource().listAppAccess()).data;
      identities = [
        {
          client_id: "https://pdpp.example.test/oauth/clients/cli-demo",
          client_name: "Claude Code on workstation",
          created_at: "2026-07-01T12:00:00.000Z",
          document_id: "cimd_demo_cli",
          logo_uri: null,
          object: "cimd_client_metadata_document",
          redirect_uris: ["http://localhost:3118/callback"],
          token_endpoint_auth_method: "none",
          updated_at: "2026-07-01T12:00:00.000Z",
        },
      ];
    }
  } else {
    try {
      const [resolvedOrigin, resolvedIdentities, resolvedGrants] = await Promise.all([
        getReferencePublicOrigin(),
        listCimdClientDocuments(),
        listAppAccess().catch(() => null),
      ]);
      origin = resolvedOrigin;
      identities = resolvedIdentities.data;
      registrations = resolvedGrants?.data ?? [];
      grantsHaveMore = resolvedGrants?.has_more ?? false;
      grantsUnavailable = resolvedGrants === null;
    } catch (err) {
      if (err instanceof ReferenceServerUnreachableError) {
        return (
          <RecordroomShellWithPalette host="this server">
            <ServerUnreachable />
          </RecordroomShellWithPalette>
        );
      }
      throw err;
    }
  }
  const targets = buildConnectTargets(origin);
  const selected =
    identities.find((identity) => identity.document_id === params.client_identity) ?? identities[0] ?? null;
  const notice = noticeText(params.notice);
  const otherEntries: SetupEntry[] = [
    {
      body: "Add this address as a remote server in Claude Code.",
      label: "Claude Code command",
      title: "Claude Code",
      value: targets.claudeCodeCommand,
    },
    {
      body: "Add this address as a remote server in Codex.",
      label: "Codex command",
      title: "Codex",
      value: targets.codexCommand,
    },
    {
      body: "For apps that read setup instructions first.",
      label: "Instructions URL",
      title: "Instructions",
      value: targets.agentEntrypoint,
    },
  ];

  return (
    <RecordroomShellWithPalette host="this server">
      <PageHeader title="Technical details for connecting an app" />

      <div className="grid gap-2">
        {params.error ? <InlineNotice kind="error" message="The change could not be saved. Try again." /> : null}
        {params.remove_error ? <InlineNotice kind="error" message="Access could not be removed. Try again." /> : null}
        {params.access_removed ? <InlineNotice kind="notice" message="Access removed." /> : null}
        {notice ? <InlineNotice kind="notice" message={notice} /> : null}
      </div>

      <Section title="Assistant address">
        <CopyRow
          body="Copy this address into an assistant to connect it to your data."
          label="assistant address"
          title="DataConnect address"
          value={targets.mcpUrl}
        />
        {needsRemoteAccess(origin) ? (
          <p className="text-[13px] text-muted-foreground">
            This address is only available on this network. Set up{" "}
            <Link className="text-primary underline-offset-2 hover:underline" href="/settings#remote-access">Remote access</Link>{" "}
            to use it elsewhere.
          </p>
        ) : null}
      </Section>

      <Section title="ChatGPT">
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
          <li>In ChatGPT, open Settings and choose Apps.</li>
          <li>Add a custom app and paste the address above.</li>
        </ol>
      </Section>

      <Section title="Claude">
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
          <li>In Claude, open Settings and choose Connectors.</li>
          <li>Add a custom connector and paste the address above.</li>
        </ol>
      </Section>

      <details className="group border-y border-border py-3">
        <summary className="min-h-11 cursor-pointer text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Other apps
        </summary>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {otherEntries.map((entry) => <CopyRow key={entry.title} {...entry} />)}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link className="text-[13px] text-primary underline-offset-2 hover:underline" href={dashboardRoutes.section.addSource}>Add a data source</Link>
          <Link className="text-[13px] text-primary underline-offset-2 hover:underline" href="/deployment/tokens">Owner credentials</Link>
        </div>
        <details className="mt-4 border-t border-border pt-3">
          <summary className="min-h-11 cursor-pointer text-[13px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
          <Section title="Connection details">
            <p className="pdpp-caption text-muted-foreground">
              Use the address for ChatGPT, Claude.ai, and remote MCP clients. Browser clients use PKCE; some clients use the device-code flow.
              Claude Code adds a remote Streamable HTTP MCP server. Codex uses the same endpoint without a separate bearer token.
            </p>
            <p className="pdpp-caption mt-3 text-muted-foreground">
              Owner credentials stay out of ordinary MCP setup. Assistants use the scoped OAuth flow at <code className="font-mono">/mcp</code>.
              That flow returns a scoped client token, never the owner bearer. Trusted local access for the owner uses a separate flow.
            </p>
          </Section>
          <Section title="Stable local client identity">
            <p className="pdpp-caption mb-3 text-muted-foreground">Create one only when a local app needs a fixed identity. The return address must match the app's callback.</p>
            <div className="grid gap-4">
              <ClientIdentityForm />
              <ClientIdentityList identities={identities} selectedId={selected?.document_id ?? null} />
            </div>
            <SelectedIdentityCommands mcpUrl={targets.mcpUrl} selected={selected} targets={targets} />
          </Section>
          <Section title="Owner credentials">
            <p className="pdpp-caption text-muted-foreground">Owner credentials are for your own trusted tools. Assistants use the address above.</p>
            <Link className="mt-2 inline-block text-[13px] text-primary underline-offset-2 hover:underline" href="/deployment/tokens">Manage owner credentials</Link>
          </Section>
        </details>
      </details>

      <Section title="Connected apps">
        <AppAccessList apps={groupGrantAccessByApp(registrations)} />
      </Section>
    </RecordroomShellWithPalette>
  );
}
