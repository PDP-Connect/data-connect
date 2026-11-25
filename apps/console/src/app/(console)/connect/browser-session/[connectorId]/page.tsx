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

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { notFound } from "next/navigation";
import { SignInConnectBody } from "../../../sources/add/connect-bodies.tsx";
import { loadServiceContext } from "../../../sources/add/service-context.ts";
import { loadBrowserConnectSupport } from "../../../lib/load-browser-connect-support.ts";
import { getStaticSecretSetup } from "../../../lib/ref-client.ts";
import { browserSignInCapture } from "../../../lib/source-setup-form-contract.ts";

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
  const context = await loadServiceContext(connectorId);

  const storedCredentialSetup = await getStaticSecretSetup(connectorId).catch(() => null);
  const capture = browserSignInCapture(storedCredentialSetup);
  const fields = (capture?.fields ?? []).map((field) => ({
    autocomplete: field.autocomplete,
    defaultValue: firstValue(resolvedSearchParams[`field_${field.name}`]),
    label: field.label,
    name: field.name,
    placeholder: field.placeholder,
    required: field.required,
    secret: field.secret,
    type: field.type,
  }));
  return (
    <RecordroomShellWithPalette>
      <SignInConnectBody
        canConnect={browserConnect.canAddAccount}
        capture={capture ? { checkboxName: capture.checkboxName, fields, required: capture.required } : null}
        error={pageParams.error}
        repairConnectionId={pageParams.connectionId}
        service={{ accounts: context.accounts, connectorKey: connectorId, icon: context.icon, name: context.displayName, tier: context.tier }}
      />
    </RecordroomShellWithPalette>
  );
}
