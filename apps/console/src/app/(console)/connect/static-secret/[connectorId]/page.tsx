// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { KeyConnectBody } from "../../../sources/add/connect-bodies.tsx";
import { loadServiceContext } from "../../../sources/add/service-context.ts";
import { getStaticSecretSetup, RefNotFoundError } from "../../../lib/ref-client.ts";
import { createStaticSecretConnectionAction, replaceStaticSecretCredentialAction } from "./actions.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function StaticSecretConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);
  const setup = await getStaticSecretSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });
  const resolvedSearchParams = await searchParams;
  const connectionId = firstValue(resolvedSearchParams.connection_id);
  const displayNameParam = firstValue(resolvedSearchParams.display_name);
  const error = firstValue(resolvedSearchParams.error);
  // A draft retry keeps the same connection id but remains in the create-form
  // presentation so the chosen account name is preserved.
  const isDraftRetryMode = Boolean(connectionId && firstValue(resolvedSearchParams.draft_retry) === "1");
  const isReplaceMode = Boolean(connectionId && !isDraftRetryMode);
  const context = await loadServiceContext(setup.connector_id, setup.display_name);
  // After a validation failure the action redirects back here with the non-secret
  // field values as `field_<name>`; the secret field is never round-tripped.
  const fields = setup.credential_capture.fields.map((field) => ({
    autocomplete: field.autocomplete,
    defaultValue: field.secret ? undefined : firstValue(resolvedSearchParams[`field_${field.name}`]),
    label: field.label,
    name: field.name,
    placeholder: field.placeholder,
    required: field.required,
    secret: field.secret,
    type: field.type,
  }));
  return (
    <RecordroomShellWithPalette>
      <KeyConnectBody
        action={connectionId ? replaceStaticSecretCredentialAction : createStaticSecretConnectionAction}
        blockers={setup.deployment_readiness.blockers}
        connectionId={connectionId}
        displayNameParam={displayNameParam}
        error={error}
        fields={fields}
        helpUrl={setup.credential_capture.fields.find((field) => field.help_url)?.help_url ?? null}
        keyIsOptional={setup.credential_capture.required === false}
        mode={isReplaceMode ? "replace" : isDraftRetryMode ? "draft-retry" : "new"}
        service={{
          accounts: context.accounts,
          connectorKey: setup.connector_id,
          icon: context.icon,
          name: context.displayName,
          tier: context.tier,
        }}
        storageReady={setup.deployment_readiness.state === "ready"}
      />
    </RecordroomShellWithPalette>
  );
}
