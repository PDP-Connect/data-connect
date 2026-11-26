// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import "server-only";
import { getDeploymentDiagnostics, listClientEventSubscriptions, listDeviceExporterDiagnostics } from "../lib/ref-client.ts";
import { collectorGroups } from "../device-exporters/collector-model.ts";
import { loadTokenGroups } from "../deployment/tokens/token-data.ts";
import { readAddSourceCatalog } from "../sources/add/add-source-catalog-read.ts";
import { buildPackageRows } from "./packages/package-rows-model.ts";

export interface SettingsSummary {
  tokens: number | null;
  collectors: number | null;
  webhooks: number | null;
  updates: number | null;
  publicAddress: string | null;
}

// An unavailable read stays unknown rather than claiming zero or “up to date”.
export async function loadSettingsSummary(): Promise<SettingsSummary> {
  const [tokens, collectors, webhooks, packages, report] = await Promise.allSettled([
    loadTokenGroups(), listDeviceExporterDiagnostics(), listClientEventSubscriptions(),
    readAddSourceCatalog({ withAccounts: false }), getDeploymentDiagnostics(),
  ]);
  const configured = report.status === "fulfilled" ? report.value.environment.find(row => row.name === "PDPP_REFERENCE_ORIGIN" && row.provenance === "present")?.value : null;
  let publicAddress: string | null = null;
  try { if (configured) { const url = new URL(configured); if (url.protocol === "https:" || url.protocol === "http:") publicAddress = url.origin; } } catch { /* An invalid setting is not a usable address. */ }
  return {
    tokens: tokens.status === "fulfilled" ? tokens.value.length : null,
    collectors: collectors.status === "fulfilled" ? collectorGroups(collectors.value.data)[0]!.devices.length : null,
    webhooks: webhooks.status === "fulfilled" ? webhooks.value.data.length : null,
    updates: packages.status === "fulfilled" ? buildPackageRows(packages.value).filter(row => row.updateTo).length : null,
    publicAddress,
  };
}
