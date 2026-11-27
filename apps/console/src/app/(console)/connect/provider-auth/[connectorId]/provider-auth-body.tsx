// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buttonVariants, type ConnectorIconLike } from "@pdpp/brand-react";
import { ConnectHeader, ExistingAccountsNote, type ExistingAccount, NewServiceNote, StartFailed } from "../../../sources/add/connect-parts.tsx";

export function ProviderAuthBody({ connectorId, displayName, connectorIcon, error, accounts = [], kinds = [], tier }: { connectorId: string; displayName: string; connectorIcon?: ConnectorIconLike | null; error?: string; accounts?: readonly ExistingAccount[]; kinds?: readonly string[]; tier?: string | null }) {
  return <>
    <ConnectHeader connectorKey={connectorId} icon={connectorIcon} name={displayName} description={`${displayName} will ask you to sign in and to allow DataConnect to read your account. DataConnect never sees your ${displayName} password.`} />
    <section className="grid max-w-xl gap-4">
      <ExistingAccountsNote accounts={accounts} connectorKey={connectorId} />
      {kinds.length > 0 ? <p className="text-muted-foreground">It will copy: {kinds.join(", ")}.</p> : null}
      <NewServiceNote name={displayName} tier={tier} />
      {error ? <StartFailed message={error} sentence={`${displayName} couldn't be reached. Try again.`} /> : null}
      <form action={`/connect/provider-auth/${encodeURIComponent(connectorId)}/start`} method="post">
        <button className={buttonVariants({ className: "min-h-11", size: "sm", variant: "default" })} type="submit">Continue to {displayName}</button>
      </form>
    </section>
  </>;
}
