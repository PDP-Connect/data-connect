// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcInput, type ConnectorIconLike } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { accountCopy, cannotAddCopy, connectHeading, gettingReadyCopy, isNewService, newServiceNote } from "./connect-copy.ts";

export interface ExistingAccount {
  readonly connectionId: string;
  readonly displayName: string;
}

/** "Connect <Name>": one logo, the name once, a way back to the list. */
export function ConnectHeader({
  connectorKey,
  description,
  icon,
  name,
  title,
  step,
  lastCrumb,
}: {
  /** The trail's last step. Default: "Add a data source"; a source's own page names the source. */
  lastCrumb?: { href: string; label: string };
  connectorKey: string;
  description?: ReactNode;
  icon: ConnectorIconLike | null | undefined;
  name: string;
  title?: string;
  step?: string;
}) {
  return (
    <PageHeader
      breadcrumbs={[
        { href: dashboardRoutes.section.overview, label: "Home" },
        { href: dashboardRoutes.section.records, label: "Data sources" },
        lastCrumb ?? { href: "/sources/add", label: "Add a data source" },
      ]}
      description={step ? <><span className="pdpp-caption">{step}</span>{description}</> : description}
      title={
        <span className="inline-flex items-center gap-2">
          <ConnectorMark connectorId={connectorKey} icon={icon} name={name} />
          {title ?? connectHeading(name)}
        </span>
      }
    />
  );
}

/** The one fold these pages allow: the server's own message, one step away. */
export function WentWrong({ message }: { message: string }) {
  return (
    <details className="pdpp-caption text-muted-foreground">
      <summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-dotted underline-offset-4">
        {gettingReadyCopy.whatWentWrong}
      </summary>
      <p className="mt-1 break-words">{message.replaceAll(/PDPP/giu, "DataConnect")}</p>
    </details>
  );
}

/** A failed start: one plain sentence, the server's message under "What went wrong". */
export function StartFailed({ message, sentence }: { message: string; sentence: string }) {
  return (
    <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive" role="alert">
      <p className="pdpp-caption">{sentence}</p>
      <WentWrong message={message} />
    </div>
  );
}

/** Tier development or preview: moved here from the badge on the list. */
export function NewServiceNote({ name, tier }: { name: string; tier: string | null | undefined }) {
  if (!isNewService(tier)) return null;
  return (
    <p className="pdpp-caption text-muted-foreground" data-testid="new-service-note">
      {newServiceNote(name)}
    </p>
  );
}

/** "You already have <name>. This adds another account." with the name field. */
export function ExistingAccountsNote({ accounts, connectorKey }: { accounts: readonly ExistingAccount[]; connectorKey: string }) {
  if (accounts.length === 0) return null;
  return (
    <p className="pdpp-caption text-muted-foreground" data-testid="existing-accounts-note">
      {accountCopy.already}{" "}
      {accounts.map((account, index) => (
        <span key={account.connectionId}>
          {index > 0 ? (index === accounts.length - 1 ? " and " : ", ") : ""}
          <Link className="text-foreground underline underline-offset-2" href={`/sources/${encodeURIComponent(connectorKey)}?connection_id=${encodeURIComponent(account.connectionId)}`}>
            {account.displayName}
          </Link>
        </span>
      ))}
      . {accountCopy.addsAnother}
    </p>
  );
}

/** Shown only when the person already has an account of this service. */
export function AccountNameField({
  accounts,
  fieldName,
  name,
}: {
  accounts: readonly ExistingAccount[];
  fieldName: string;
  name: string;
}) {
  if (accounts.length === 0) return null;
  return (
    <label className="grid gap-1" htmlFor={`account-name-${fieldName}`}>
      <span className="pdpp-eyebrow">{accountCopy.nameLabel}</span>
      <IcInput
        className="min-h-11"
        id={`account-name-${fieldName}`}
        maxLength={200}
        name={fieldName}
        placeholder={accountCopy.namePlaceholder(name)}
      />
    </label>
  );
}

/** "<Name> can't be added here yet." and, when the server gives a reason, that reason. */
export function CannotBeAddedHere({ name, reason }: { name: string; reason?: string | null }) {
  return (
    <div className="grid max-w-xl gap-3" data-testid="cannot-be-added-here">
      <p className="text-foreground">{cannotAddCopy.heading(name)}</p>
      {reason ? <p className="pdpp-caption text-muted-foreground">{reason}</p> : null}
      <div>
        <Link className={buttonVariants({ size: "sm", variant: "default" })} href="/sources/add">
          {cannotAddCopy.back}
        </Link>
      </div>
    </div>
  );
}

/** Quiet activity mark shared by opening and copying; still in reduced motion. */
export function ConnectWorkingMark({ label }: { label: string }) {
  return <div aria-label={label} role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" /></div>;
}
