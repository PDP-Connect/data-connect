// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SupportCopy } from "../components/support-copy.tsx";
import { formatConnectorKeyForDisplay } from "@pdpp/display"
import { Callout, PageHeader } from "@pdpp/operator-ui/components/primitives"
import Link from "next/link"
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx"
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx"
import { loadBrowserBoundVerdict } from "../lib/load-browser-connect-support.ts"
import { loadLocalCollectorTemplates } from "../lib/load-local-collector-support.ts"
import {
  localCollectorEnrollmentKeys,
  resolveLocalCollectorEnrollmentKey,
} from "../lib/local-collector-support.ts"
import {
  getReferencePublicOrigin,
  ReferenceServerUnreachableError,
} from "../lib/owner-token.ts"
import { listDeviceExporterDiagnostics } from "../lib/ref-client.ts"
import { listConnectorManifests } from "../lib/rs-client.ts"
import { CollectorSetup } from "./collector-setup.tsx"
import { CollectorList } from "./collector-list.tsx"
import { buildCollectorPractice } from "./collector-model.ts"

export const metadata = {
  title: "Collectors on your devices",
}

export default async function DeviceExportersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  // The Sources "Add source" catalog deep-links here only for packaged local
  // collectors (`?connector=claude-code` / `codex`). Browser-bound
  // connectors are deliberately not prefilled here: their old monorepo proof
  // command is not an owner-usable setup path.
  const resolvedSearchParams = searchParams ? await searchParams : undefined
  const demo = resolvedSearchParams?.demo
  const practice =
    process.env.NODE_ENV !== "production" && typeof demo === "string"
      ? buildCollectorPractice(demo)
      : null
  if (practice)
    return (
      <RecordroomShellWithPalette>
        <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6">
          <CollectorHeading />
          <CollectorList devices={practice} practice />
        </main>
      </RecordroomShellWithPalette>
    )
  const connectorParam = resolvedSearchParams?.connector
  const requestedConnector = Array.isArray(connectorParam)
    ? connectorParam[0]
    : connectorParam
  // The server's connector templates say which connectors can enroll a local
  // collector; the console holds no key list of its own.
  const collectorTemplates = (await loadLocalCollectorTemplates()) ?? []
  const collectorConnectorIds = localCollectorEnrollmentKeys(collectorTemplates)
  const defaultConnectorId =
    resolveLocalCollectorEnrollmentKey(
      collectorTemplates,
      requestedConnector
    ) ?? undefined
  // A deep-link to an unsupported *browser-bound* connector is an intentful
  // request this page cannot generate commands for yet. Detect that case from the
  // connector's own browser binding and surface an honest notice that names the
  // connector and points at the owner-run runbook — never a faked enroll flow.
  const browserBoundRequest =
    !defaultConnectorId &&
    requestedConnector &&
    (await loadBrowserBoundVerdict(requestedConnector)) === true
      ? requestedConnector
      : undefined

  // When the owner arrives here from the "Add source" picker (a validated
  // `?connector=` deep-link), frame the page as finishing the connector they
  // chose — a "Sources / Add <Connector>" breadcrumb — instead of the bare
  // diagnostics-console header. The breadcrumb is only shown for a connector key
  // already validated against the supported sets, so it never names an arbitrary
  // value. The bare page (no deep-link) keeps its existing diagnostics framing.

  const addConnectionBreadcrumbs = defaultConnectorId
    ? [
        { label: "Sources", href: "/sources" },
        { label: `Add ${formatConnectorKeyForDisplay(defaultConnectorId)}` },
      ]
    : undefined
  let loaded
  try {
    loaded = await Promise.all([
      listDeviceExporterDiagnostics(),
      getReferencePublicOrigin(),
      listConnectorManifests().catch(() => []),
    ])
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Collectors on your devices" />
          <p>
            This could not be loaded.{" "}
            <Link href="/device-exporters">Try again</Link>.
          </p>
          <SupportCopy details={err.message} />
        </RecordroomShellWithPalette>
      )
    }
    throw err
  }
  const [diagnostics, referenceBaseUrl, connectorManifests] = loaded
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap(manifest => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key
        ? ([[manifest.connector_key, manifest.icon]] as const)
        : []),
    ])
  )
  const devices = diagnostics.data

  return (
    <RecordroomShellWithPalette>
      <CollectorHeading breadcrumbs={addConnectionBreadcrumbs} />

      {browserBoundRequest ? (
        <BrowserBoundEnrollmentNotice
          connectorIcon={connectorIcons[browserBoundRequest]}
          connectorId={browserBoundRequest}
        />
      ) : null}

      <CollectorSetup
        collectorConnectorIds={collectorConnectorIds}
        defaultConnectorId={defaultConnectorId}
        referenceBaseUrl={referenceBaseUrl}
      />
      <CollectorList devices={devices} collectorConnectorIds={collectorConnectorIds} referenceBaseUrl={referenceBaseUrl} />
    </RecordroomShellWithPalette>
  )
}

/**
 * Honest notice for a browser-bound connector deep-link that has no generated
 * console setup path yet.
 */
function BrowserBoundEnrollmentNotice({
  connectorIcon,
  connectorId,
}: {
  connectorIcon?: import("@pdpp/brand-react").ConnectorIconLike | null
  connectorId: string
}) {
  return (
    <Callout
      className="mb-4"
      description={`${formatConnectorKeyForDisplay(connectorId)} needs a browser sign-in. Browser setup is not available in this dashboard yet.`}
      surface="human"
      title={
        <span className="inline-flex items-center gap-2">
          <ConnectorMark
            connectorId={connectorId}
            icon={connectorIcon}
            name={formatConnectorKeyForDisplay(connectorId)}
          />
          Browser setup not available yet
        </span>
      }
    >
      <p className="pdpp-caption text-muted-foreground">
        Existing data remains available. Adding another account is not available
        yet. See available setup paths on the{" "}
        <Link
          className="underline underline-offset-2 hover:text-foreground"
          href="/sources/add"
        >
          Add source
        </Link>{" "}
        page.
      </p>
    </Callout>
  )
}

function CollectorHeading({
  breadcrumbs,
}: {
  breadcrumbs?: { label: string; href?: string }[]
}) {
  return (
    <PageHeader
      breadcrumbs={breadcrumbs}
      title={
        <>
          Collectors on your devices{" "}
          <span className="text-sm text-muted-foreground">Experimental</span>
        </>
      }
      description="A collector runs on a phone or computer that holds data DataConnect can’t reach from here, and sends it to DataConnect. Setting one up needs a terminal on that device."
    />
  )
}
