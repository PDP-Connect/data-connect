// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, type ConnectorIconLike } from "@pdpp/brand-react";
import type { ReactNode } from "react";
import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx";
import { connectHeading, fileCopy, keyCopy, signInCopy } from "./connect-copy.ts";
import {
  AccountNameField,
  CannotBeAddedHere,
  ConnectHeader,
  type ExistingAccount,
  ExistingAccountsNote,
  NewServiceNote,
  StartFailed,
} from "./connect-parts.tsx";
import { CredentialFields, type CredentialFieldSpec, OptionalSignIn } from "./credential-fields.tsx";

/** "Open Health. Tap your picture." becomes two lines; a sentence ends at . ! or ? before a capital or digit. */
export function oneSentencePerLine(step: string): string[] {
  return step
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * The page bodies of "Connect <Name>" for each kind of service. Pages read the
 * server and pass plain facts in; keeping the markup here lets a test render
 * every state of every kind.
 */

interface ServiceFacts {
  readonly accounts: readonly ExistingAccount[];
  readonly connectorKey: string;
  readonly icon: ConnectorIconLike | null | undefined;
  readonly name: string;
  readonly tier: string | null;
}

export interface SignInCapture {
  readonly checkboxName: string;
  readonly fields: readonly CredentialFieldSpec[];
  readonly required: boolean;
}

/** Sign-in services (Amazon, Chase, ...). `repairConnectionId` reconnects an account that exists. */
export function SignInConnectBody({
  capture,
  canConnect,
  error,
  repairConnectionId,
  service,
}: {
  canConnect: boolean;
  capture: SignInCapture | null;
  error?: string | undefined;
  repairConnectionId?: string | undefined;
  service: ServiceFacts;
}) {
  const { name } = service;
  const repairMode = Boolean(repairConnectionId);
  if (!(repairMode || canConnect)) {
    return <CannotBeAddedHere name={name} />;
  }
  const accounts = repairMode ? [] : service.accounts;
  return (
    <>
      <ConnectHeader
        connectorKey={service.connectorKey}
        description={signInCopy.lead(name)}
        icon={service.icon}
        name={name}
        title={repairMode ? `Reconnect ${name}` : connectHeading(name)}
      />
      <div className="grid max-w-xl gap-4 py-4">
        {error ? <StartFailed message={error} sentence="The sign-in could not start. Try again." /> : null}
        <ExistingAccountsNote accounts={accounts} connectorKey={service.connectorKey} />
        <form
          action={`/connect/browser-session/${encodeURIComponent(service.connectorKey)}/start`}
          className="grid gap-4"
          method="post"
        >
          {repairConnectionId ? <input name="connection_id" type="hidden" value={repairConnectionId} /> : null}
          <AccountNameField accounts={accounts} fieldName="display_name" name={name} />
          {capture?.required ? (
            <>
              <input name="credential_capture_required" type="hidden" value="1" />
              <CredentialFields fields={capture.fields} idPrefix="sign-in" required />
              <p className="pdpp-caption text-muted-foreground">{signInCopy.storage(name)}</p>
            </>
          ) : null}
          <NewServiceNote name={name} tier={service.tier} />
          <div>
            <button className={buttonVariants({ className: "min-h-11", size: "lg", variant: "default" })} type="submit">
              {repairMode ? `Reconnect ${name}` : signInCopy.button(name)}
            </button>
          </div>
          {capture && !capture.required ? (
            <OptionalSignIn checkboxName={capture.checkboxName} fields={capture.fields} name={name} />
          ) : null}
        </form>
      </div>
    </>
  );
}

/** Key services (YNAB, Notion, ...). */
export function KeyConnectBody({
  action,
  blockers,
  connectionId,
  displayNameParam,
  error,
  fields,
  helpUrl,
  keyIsOptional,
  mode,
  service,
  storageReady,
}: {
  action: (formData: FormData) => void | Promise<void>;
  blockers: readonly { key: string }[];
  connectionId?: string | undefined;
  displayNameParam?: string | undefined;
  error?: string | undefined;
  fields: readonly CredentialFieldSpec[];
  helpUrl: string | null;
  /** True when the server says a blank submission is valid. */
  keyIsOptional: boolean;
  /** "new" creates an account; "draft-retry" keeps the name chosen before; "replace" swaps the key of an account. */
  mode: "draft-retry" | "new" | "replace";
  service: ServiceFacts;
  storageReady: boolean;
}) {
  const { name } = service;
  const reconnecting = mode !== "new";
  const accounts = connectionId ? [] : service.accounts;
  return (
    <>
      <ConnectHeader
        connectorKey={service.connectorKey}
        description={
          // Storage not ready: only the heading and the blocked text (design "Key services").
          storageReady ? (
          <span>
            {keyCopy.lead(name)}
            {helpUrl ? (
              <>
                {" "}
                <OpenExternalLink
                  className="underline decoration-dotted underline-offset-4"
                  href={helpUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {keyCopy.whereToFind}
                </OpenExternalLink>
              </>
            ) : null}
          </span>
          ) : undefined
        }
        icon={service.icon}
        name={name}
        title={reconnecting ? `Reconnect ${name}` : connectHeading(name)}
      />
      <div className="grid max-w-xl gap-4 py-4">
        {error ? <StartFailed message={error} sentence="The key could not be saved. Try again." /> : null}
        {storageReady ? (
          <>
            <ExistingAccountsNote accounts={accounts} connectorKey={service.connectorKey} />
            <form action={action} className="grid gap-4">
              <input name="connector_id" type="hidden" value={service.connectorKey} />
              {connectionId ? <input name="connection_id" type="hidden" value={connectionId} /> : null}
              {accounts.length === 0 && displayNameParam && mode !== "replace" ? (
                <input name="display_name" type="hidden" value={displayNameParam} />
              ) : null}
              {mode === "replace" ? null : <AccountNameField accounts={accounts} fieldName="display_name" name={name} />}
              <CredentialFields fields={fields} idPrefix="key" required={!keyIsOptional} />
              <p className="pdpp-caption text-muted-foreground">{keyCopy.storage(name)}</p>
              <NewServiceNote name={name} tier={service.tier} />
              <div>
                <IcButton className="min-h-11" type="submit" variant="default">
                  {reconnecting ? `Reconnect ${name}` : keyCopy.button(name)}
                </IcButton>
              </div>
            </form>
          </>
        ) : (
          <div className="grid gap-2" data-testid="key-storage-not-ready">
            <p className="text-foreground">{keyCopy.storageNotReady(name)}</p>
            <p className="text-muted-foreground">
              Whoever set up this server needs to turn on key storage. The{" "}
              <OpenExternalLink
                className="underline underline-offset-4"
                href="https://github.com/PDP-Connect/data-connect/blob/main/deploy/docker/README.md"
                rel="noopener noreferrer"
                target="_blank"
              >install guide</OpenExternalLink> shows how.
            </p>
            <p className="pdpp-caption text-muted-foreground">The settings are</p>
            <ul className="grid gap-1 pdpp-caption text-muted-foreground">
              {blockers.map((blocker) => (
                <li key={blocker.key}>
                  <code>{blocker.key}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

/** File services (Apple Health, WhatsApp, ...): the two numbered steps around the file form. */
export function FileConnectBody({
  form,
  instructions,
  service,
  title,
}: {
  form: ReactNode;
  instructions: { links: readonly { href: string; label: string }[]; steps: readonly string[] };
  service: ServiceFacts;
  title?: string | undefined;
}) {
  const { name } = service;
  return (
    <>
      <ConnectHeader
        connectorKey={service.connectorKey}
        description={fileCopy.lead(name)}
        icon={service.icon}
        name={name}
        title={title}
      />
      <div className="grid max-w-2xl gap-6 py-4">
        <section aria-labelledby="export-step" className="grid gap-2">
          <h2 className="pdpp-title text-foreground" id="export-step">1. {fileCopy.exportStep}</h2>
          {instructions.steps.length > 0 ? (
            <ol className="grid list-decimal gap-1 pl-5 pdpp-body text-muted-foreground" data-testid="export-steps">
              {instructions.steps.flatMap(oneSentencePerLine).map((sentence, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of sentences; the same sentence may repeat.
                <li key={`${index}-${sentence}`}>{sentence.replaceAll(/PDPP/giu, "DataConnect")}</li>
              ))}
            </ol>
          ) : null}
          {instructions.links.length > 0 ? (
            <ul className="grid gap-1" data-testid="export-links">
              {instructions.links.map((link) => (
                <li key={link.href}>
                  <OpenExternalLink
                    className="pdpp-caption inline-flex min-h-11 items-center underline decoration-dotted underline-offset-4"
                    href={link.href}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {link.label}
                  </OpenExternalLink>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section aria-labelledby="choose-step" className="grid gap-2">
          <h2 className="pdpp-title text-foreground" id="choose-step">2. {fileCopy.chooseStep}</h2>
          {form}
        </section>
      </div>
    </>
  );
}
