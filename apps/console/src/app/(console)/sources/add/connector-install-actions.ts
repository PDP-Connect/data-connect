"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import {
  addConnectorLocalSource,
  installConnector,
  listConnectorInstallCatalog,
  reloadConnectorLocalSource,
  removeConnectorLocalSource,
  selectConnectorLocalSource,
  updateConnector,
  uninstallConnector,
} from "../../lib/connector-install-client.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";

export type ConnectorInstallActionResult = { ok: true } | { ok: false; message: string };

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected connector package action failure.";
}

export async function installConnectorAction(
  connectorId: string,
  digest: string
): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  const normalizedConnectorId = connectorId.trim();
  const normalizedDigest = digest.trim();
  if (!(normalizedConnectorId && normalizedDigest)) {
    return {
      message: "The connector package target is incomplete. Reload the catalog and try again.",
      ok: false,
    };
  }
  try {
    // The rendered digest can be older than the catalog by the time the owner
    // clicks. The server accepts any verified catalog digest, so refuse one
    // that is no longer the latest rather than install a superseded package.
    //
    // This is a check-then-act: the catalog can change between this read and
    // the install request below, and the install route does not accept an
    // expected-latest condition. A window of one round trip remains in which a
    // superseded digest can still be installed; closing it needs the install
    // route to take that condition, which is outside this change.
    const latest = (await listConnectorInstallCatalog()).find(
      (entry) => entry.connector_id === normalizedConnectorId && entry.latest
    );
    if (!latest) {
      revalidatePath("/sources/add");
      return {
        message: "This package is no longer listed in the catalog. Reload the catalog and try again.",
        ok: false,
      };
    }
    if (latest.digest !== normalizedDigest) {
      revalidatePath("/sources/add");
      return {
        message: "A newer package version is available. Reload the catalog and try again.",
        ok: false,
      };
    }
    await installConnector({
      connectorId: normalizedConnectorId,
      digest: normalizedDigest,
    });
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}

export async function updateConnectorAction(connectorId: string): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  const normalizedConnectorId = connectorId.trim();
  if (!normalizedConnectorId) {
    return {
      message: "The connector package target is incomplete. Reload the catalog and try again.",
      ok: false,
    };
  }
  try {
    await updateConnector(normalizedConnectorId);
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}

export async function uninstallConnectorAction(connectorKey: string): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  const normalizedKey = connectorKey.trim();
  if (!normalizedKey) return { message: "The connector package target is incomplete.", ok: false };
  try {
    await uninstallConnector(normalizedKey);
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}

export async function addConnectorLocalSourceAction(sourcePath: string): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  if (!sourcePath.trim()) {
    return { message: "Enter the absolute path to a built Collection Profile.", ok: false };
  }
  try {
    await addConnectorLocalSource(sourcePath.trim());
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}

export async function reloadConnectorLocalSourceAction(sourceId: string): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  try {
    await reloadConnectorLocalSource(sourceId.trim());
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}

export async function removeConnectorLocalSourceAction(sourceId: string): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  try {
    await removeConnectorLocalSource(sourceId.trim());
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}

export async function selectConnectorLocalSourceAction(
  connectorKey: string,
  sourceId: string | null
): Promise<ConnectorInstallActionResult> {
  await requireDashboardAccess("/sources/add");
  try {
    await selectConnectorLocalSource({ connectorKey: connectorKey.trim(), sourceId });
    revalidatePath("/sources/add");
    return { ok: true };
  } catch (err) {
    return { message: actionMessage(err), ok: false };
  }
}
