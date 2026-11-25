// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-session connect/repair page.
 *
 * Entry point for browser-bound connector setup and re-authentication.
 *
 * SETUP (no ?connectionId): supported browser-collector connectors show a new
 * account form with an optional source label and a clear link back to Sources
 * for owners who need to reconnect an existing source. Unsupported
 * browser-bound connectors still fail closed on this route.
 *
 * REPAIR (?connectionId=<existing>): skips shell creation and starts a new run
 * against the existing connection (Plaid update-mode equivalent). The
 * connection_id, history, schedule, and records are unchanged.
 *
 * The page is deliberately minimal — setup mode presents a clear new-account
 * vs reconnect choice, and repair mode keeps the single primary CTA. The
 * browser interaction itself happens in the run stream page
 * (apps/console/src/app/(console)/syncs/[runId]/stream/).
 *
 * Design reference: docs/research/slvp-ideal-browser-device-connector-setup-2026-06-14.md §3B/3C
 */

import { buttonVariants, IcInput } from "@pdpp/brand-react";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import { loadBrowserConnectSupport } from "../../../lib/load-browser-connect-support.ts";
import { getStaticSecretSetup, type StaticSecretSetupField } from "../../../lib/ref-client.ts";
import { findManifestForConnectorId } from "../../../sources/lib/relationships.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
import {
  type BrowserCredentialContract,
  browserSessionFormContract,
  browserCredentialFieldLabel,
  connectionNameFieldContract,
} from "../../../lib/source-setup-form-contract.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  /** Repair mode: existing connection_id to re-authenticate (Plaid update-mode). */
  connectionId?: string;
  /** Error from a prior start attempt. */
  error?: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive" role="alert">
      <p>Could not start browser setup. Try again.</p>
      <details className="mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
        <p className="mt-1">{message.replaceAll(/PDPP/giu, "DataConnect")}</p>
      </details>
    </div>
  );
}

function inputType(field: StaticSecretSetupField): "email" | "password" | "text" {
  return field.type === "email" || field.type === "password" ? field.type : "text";
}

function StoredCredentialFields({
  credentials,
  searchParams,
}: {
  credentials: BrowserCredentialContract;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  return (
    <fieldset
      className="grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-4"
      data-testid="browser-credential-capture"
    >
      <legend className="pdpp-eyebrow px-1 text-foreground">{credentials.title.replaceAll(/PDPP/giu, "DataConnect")}</legend>
      <p className="pdpp-caption text-muted-foreground">{credentials.description.replaceAll(/PDPP/giu, "DataConnect")}</p>
      {credentials.required ? (
        <input name="credential_capture_required" type="hidden" value="1" />
      ) : (
        <label className="flex min-h-11 items-center gap-2" htmlFor="browser-remember-sign-in">
          <input
            className="mt-0.5 size-4 rounded border-border accent-primary"
            id="browser-remember-sign-in"
            name={credentials.checkboxName}
            type="checkbox"
            value="1"
          />
          <span className="pdpp-caption text-foreground">{credentials.checkboxLabel.replaceAll(/PDPP/giu, "DataConnect")}</span>
        </label>
      )}
      <div className="grid gap-3 border-border/60 border-t pt-3" data-testid="browser-credential-fields">
        {credentials.fields.map((field) => (
          <label className="grid gap-1" htmlFor={`browser-credential-${field.name}`} key={field.name}>
            <span className="pdpp-eyebrow">{browserCredentialFieldLabel(field, credentials.required)}</span>
            <IcInput
              autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
              className="min-h-11"
              defaultValue={field.secret ? undefined : firstValue(searchParams[`field_${field.name}`])}
              id={`browser-credential-${field.name}`}
              name={field.name}
              placeholder={field.placeholder ?? undefined}
              required={credentials.required && field.required}
              type={inputType(field)}
            />
            {field.description || field.help_text || field.help_url ? (
              <span className="pdpp-caption text-muted-foreground">
                {(field.description ?? field.help_text)?.replaceAll(/PDPP/giu, "DataConnect")}
                {field.help_url ? (
                  <>
                    {" "}
                    <OpenExternalLink
                      className="inline-flex min-h-11 items-center underline decoration-dotted underline-offset-4"
                      href={field.help_url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Open provider setup page in a new tab
                    </OpenExternalLink>
                  </>
                ) : null}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function UnavailableSetupCard() {
  return (
    <div className="grid gap-3">
      <Link className={buttonVariants({ size: "sm", variant: "default" })} href="/sources/add">
        Add a data source
      </Link>
      <details className="pdpp-caption text-muted-foreground">
        <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
        <p className="mt-2">An existing data source may still be reconnected from Data sources.</p>
      </details>
    </div>
  );
}

export default async function BrowserSessionConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  // Only browser-bound connectors belong here.
  const browserConnect = await loadBrowserConnectSupport(connectorId);
  if (!browserConnect.browserBound) {
    notFound();
  }

  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    connectionId: firstValue(resolvedSearchParams.connectionId),
    error: firstValue(resolvedSearchParams.error),
  };

  const repairMode = Boolean(pageParams.connectionId);
  const supportedBrowserCollector = browserConnect.canAddAccount;
  const storedCredentialSetup = supportedBrowserCollector
    ? await getStaticSecretSetup(connectorId).catch(() => null)
    : null;
  const browserFormContract = browserSessionFormContract(storedCredentialSetup);
  const displayName = formatConnectorKeyForDisplay(connectorId);
  const connectorIcon = findManifestForConnectorId(await listConnectorManifests().catch(() => []), connectorId)?.icon;
  const connectionName = connectionNameFieldContract(displayName);
  const pageTitle = repairMode ? `Reconnect ${displayName}` : `Connect ${displayName}`;
  const primaryActionLabel = repairMode ? `Reconnect ${displayName}` : "Connect account";
  // Repair works even where adding a new account is unavailable, so repair mode keeps the sign-in line.
  const setupDescription = repairMode || supportedBrowserCollector
    ? `Sign in to ${displayName} in the browser below.`
    : "This data source cannot be connected here yet.";
  const setupPanel = supportedBrowserCollector ? (
    <div className="space-y-4">
      <div className="grid gap-4">
        <form action={`/connect/browser-session/${encodeURIComponent(connectorId)}/start`} method="post">
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1" htmlFor="browser-session-display-name">
              <span className="pdpp-eyebrow">{connectionName.label}</span>
              <IcInput
                id="browser-session-display-name"
                maxLength={connectionName.maxLength}
                name={connectionName.name}
                placeholder={connectionName.placeholder}
              />
              <span className="pdpp-caption text-muted-foreground">
                {connectionName.helpText.replace("new source", "new data source")}
              </span>
            </label>
            {browserFormContract.credentialCapture ? (
              <StoredCredentialFields
                credentials={browserFormContract.credentialCapture}
                searchParams={resolvedSearchParams}
              />
            ) : null}
            <button
              className={buttonVariants({
                className: "min-h-11 w-full justify-center",
                size: "lg",
                variant: "default",
              })}
              type="submit"
            >
              {primaryActionLabel}
            </button>
          </div>
        </form>
      </div>

      <details className="pdpp-caption text-muted-foreground">
        <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
        <p className="mt-2">{browserFormContract.setupDescription.replaceAll(/PDPP/giu, "DataConnect")}</p>
        <p className="mt-2">Create a new account in a secure browser.</p>
        <p className="mt-2">Choose an existing data source to reconnect.</p>
        <Link className="mt-2 inline-flex min-h-11 items-center underline underline-offset-2" href="/sources">
          Choose an existing data source
        </Link>
        <p className="mt-2">If the browser does not open, return to Data sources and retry from this data source.</p>
      </details>
    </div>
  ) : (
    <UnavailableSetupCard />
  );

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ className: "min-h-11", size: "sm", variant: "ghost" })} href="/sources">
            Back to Data sources
          </Link>
        }
        description={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={displayName} />
            <span>{setupDescription}</span>
          </span>
        }
        title={
          <span className="inline-flex items-center gap-2">
            <ConnectorMark connectorId={connectorId} icon={connectorIcon} name={displayName} />
            {pageTitle}
          </span>
        }
      />

      <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
        {pageParams.error ? <InlineError message={pageParams.error} /> : null}

        {repairMode ? null : setupPanel}

        {repairMode ? (
          <details className="pdpp-caption text-muted-foreground">
            <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
            <ol className="mt-2 list-inside list-decimal space-y-2">
              <li>Select <strong className="text-foreground">{primaryActionLabel}</strong> below to open the browser.</li>
              <li>Sign in to {displayName} in the browser.</li>
              <li>{browserFormContract.repairLoginDescription.replaceAll(/PDPP/giu, "DataConnect")}</li>
              <li>If the browser does not open, choose Try again.</li>
              <li>Your existing records and history stay in place.</li>
              {pageParams.connectionId ? <li>Connection ID: {pageParams.connectionId}</li> : null}
            </ol>
          </details>
        ) : null}

        {/* Primary CTA */}
        {repairMode ? (
          <form action={`/connect/browser-session/${encodeURIComponent(connectorId)}/start`} method="post">
            {pageParams.connectionId ? (
              <input name="connection_id" type="hidden" value={pageParams.connectionId} />
            ) : null}
            {browserFormContract.credentialCapture ? (
              <StoredCredentialFields
                credentials={browserFormContract.credentialCapture}
                searchParams={resolvedSearchParams}
              />
            ) : null}
            <button
              className={buttonVariants({
                className: "min-h-11 w-full justify-center",
                size: "lg",
                variant: "default",
              })}
              type="submit"
            >
              {primaryActionLabel}
            </button>
          </form>
        ) : null}

      </div>
    </RecordroomShellWithPalette>
  );
}
