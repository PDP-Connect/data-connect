"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { pdppLocalCollectorSetupCommand } from "@/lib/pdpp-cli-command.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { loadLocalCollectorTemplates } from "../../lib/load-local-collector-support.ts";
import { resolveLocalCollectorEnrollmentKey } from "../../lib/local-collector-support.ts";
import { getReferencePublicOrigin } from "../../lib/owner-token.ts";
import { createDeviceEnrollmentCode, listDeviceExporterSourceInstances } from "../../lib/ref-client.ts";
import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";

export type ProgramCommandResult =
  | { command: string; issuedAt: string; ok: true }
  | { message: string; ok: false };

/** Mints a short-lived code and returns the one command to run on the computer that has the data. */
export async function createProgramCommandAction(connectorKey: string): Promise<ProgramCommandResult> {
  await requireDashboardAccess("/sources/add");
  try {
    const templates = await loadLocalCollectorTemplates();
    const enrollmentKey = templates ? resolveLocalCollectorEnrollmentKey(templates, connectorKey) : null;
    if (!enrollmentKey) return { message: "The server does not list this program for enrollment.", ok: false };
    const issuedAt = new Date().toISOString();
    const [code, baseUrl] = await Promise.all([
      createDeviceEnrollmentCode({
        connector_id: enrollmentKey,
        expires_in_seconds: 900,
        local_binding_name: "this-computer",
      }),
      getReferencePublicOrigin(),
    ]);
    return {
      command: pdppLocalCollectorSetupCommand({ baseUrl, code: code.enrollment_code, connectorId: enrollmentKey }),
      issuedAt,
      ok: true,
    };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/** True once a program of this service has enrolled after the code was issued. */
export async function programCheckedInAction(connectorKey: string, since: string): Promise<boolean> {
  await requireDashboardAccess("/sources/add");
  const wanted = canonicalConnectorKey(connectorKey);
  const sinceMs = Date.parse(since);
  const { data } = await listDeviceExporterSourceInstances();
  return data.some(
    (instance) =>
      canonicalConnectorKey(instance.connector_id) === wanted && Date.parse(instance.created_at) >= sinceMs
  );
}
