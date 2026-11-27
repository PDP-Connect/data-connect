// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buttonVariants } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { AppAccess } from "../grants/app-access.ts";
import { assistantInstructions, claudeCodeCommand } from "./assistant-instructions.ts";
import { CopyAddress } from "./copy-address.tsx";
import { addressReach, mcpEndpoint, needsRemoteAccess } from "./remote-access.ts";
/** The assistants that run on the internet, so they cannot use an address that only works on this network. */
const REMOTE_ONLY_ASSISTANTS = new Set(["ChatGPT", "Claude"]);

export function ConnectView({ origin, apps }: { origin: string; apps: AppAccess[] }) {
  const newest = apps[0];
  if (addressReach(origin).kind === "unusable") {
    return (
      <>
        <PageHeader title="Connect an app" breadcrumbs={[{ href: "/grants", label: "Apps" }, { label: "Connect an app" }]} />
        <p>DataConnect does not have a usable address yet.</p>
        <Link className={buttonVariants()} href="/settings/remote-access">Set up remote access</Link>
      </>
    );
  }
  const needsRemote = needsRemoteAccess(origin);
  return (
    <>
      <PageHeader breadcrumbs={[{ href: "/grants", label: "Apps" }, { label: "Connect an app" }]} title="Connect an app" />
      <p className="mb-6 text-muted-foreground">
        Give your assistant the address below. It will then ask you, on a DataConnect page, what it may read.
      </p>
      {needsRemote ? (
        <div className="mb-6 rounded-md border border-warning p-4">
          <p>ChatGPT and Claude can't reach this DataConnect yet. Its address {addressReach(origin).phrase ?? "only works on your own network"}.</p>
          <p className="mt-2">
            Remote access gives this DataConnect an address on the internet that only apps you approve can use.
          </p>
          <Link className={buttonVariants()} href="/settings/remote-access">
            Set up remote access
          </Link>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Apps on this computer, such as Claude Code, can already use the address below.
          </p>
        </div>
      ) : null}
      <Section title="1. Copy your address">
        <CopyAddress address={mcpEndpoint(origin)} />
      </Section>
      <Section title="2. Add it to your assistant">
        <div className="grid gap-6 sm:grid-cols-2">
          {assistantInstructions.map((assistant) => (
            <section className="min-w-0" key={assistant.name}>
              <h3 className="pdpp-title">{assistant.name}</h3>
              {needsRemote && REMOTE_ONLY_ASSISTANTS.has(assistant.name) ? (
                <p className="text-[13px] text-muted-foreground">
                  Not available until remote access is on.{" "}
                  <Link className="underline underline-offset-4" href="/settings/remote-access">
                    Set up remote access
                  </Link>
                </p>
              ) : (
                <ol className="list-decimal space-y-2 pl-5 text-[13px]">
                  {assistant.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
              {assistant.name === "Claude Code" ? <CopyAddress address={claudeCodeCommand(origin)} command /> : null}
              {assistant.help ? (
                <a
                  className="mt-2 inline-block text-[13px] text-muted-foreground"
                  href={assistant.help}
                  rel="noreferrer"
                  target="_blank"
                >
                  {assistant.name}'s help
                </a>
              ) : null}
            </section>
          ))}
        </div>
      </Section>
      <Section title="3. Say what it may read">
        <p>Your assistant opens a DataConnect page. Tick what it may read and press Allow.</p>
      </Section>
      <Section title="Did it work?">
        <p>
          {newest
            ? apps.length > 1
              ? `${newest.name} and ${apps.length - 1} other app${apps.length === 2 ? "" : "s"} are connected.`
              : `${newest.name} is connected. It can read ${newest.sources.join(", ")}.`
            : "No app is connected yet."}
        </p>
        {newest ? <Link href="/grants">See your apps</Link> : null}
        {newest ? (
          <p className="mt-3 text-[13px] text-muted-foreground">
            Now ask it something only your data can answer, for example: “What did I spend on groceries last month?”
          </p>
        ) : null}
      </Section>
      <Link className="text-[13px] text-muted-foreground" href="/connect/technical">
        Technical details
      </Link>
    </>
  );
}
