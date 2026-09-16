"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import {
  addConnectorLocalSource,
  installConnector,
  reloadConnectorLocalSource,
  removeConnectorLocalSource,
  selectConnectorLocalSource,
  updateConnector,
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
