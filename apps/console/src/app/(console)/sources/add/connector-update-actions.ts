"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import {
  createConnectorUpdateBatch,
  createConnectorUpdateConsent,
  createConnectorUpdatePlan,
  getConnectorUpdateBatch,
  getConnectorUpdatePlan,
} from "../../lib/connector-install-client.ts";
import {
  type ConnectorUpdateBatch,
  type ConnectorUpdatePlan,
  parseConnectorUpdateBatch,
  parseConnectorUpdateConsentToken,
  parseConnectorUpdateJobId,
  parseConnectorUpdatePlan,
} from "../../lib/connector-update-contract.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { ResourceServerHttpError } from "../../lib/owner-token.ts";

export type UpdateActionResult<T> = { ok: true; data: T } | { ok: false; message: string; status?: number };

async function updateAction<T>(work: () => Promise<T>): Promise<UpdateActionResult<T>> {
  await requireDashboardAccess("/sources/add");
  try {
    return { data: await work(), ok: true };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : "Connector update request failed.",
      ok: false,
      ...(error instanceof ResourceServerHttpError ? { status: error.status } : {}),
    };
  }
}

export async function createUpdatePlanAction(): Promise<UpdateActionResult<string>> {
  return await updateAction(async () => parseConnectorUpdateJobId(await createConnectorUpdatePlan(), "plan_id"));
}

export async function getUpdatePlanAction(planId: string): Promise<UpdateActionResult<ConnectorUpdatePlan>> {
  return await updateAction(async () => parseConnectorUpdatePlan(await getConnectorUpdatePlan(planId)));
}

export async function applyUpdatePlanAction(
  planId: string,
  idempotencyKey: string
): Promise<UpdateActionResult<string>> {
  return await updateAction(async () =>
    parseConnectorUpdateJobId(await createConnectorUpdateBatch({ idempotencyKey, planId }), "batch_id")
  );
}

export async function getUpdateBatchAction(batchId: string): Promise<UpdateActionResult<ConnectorUpdateBatch>> {
  return await updateAction(async () => {
    const batch = parseConnectorUpdateBatch(await getConnectorUpdateBatch(batchId));
    if (batch.state === "completed" || batch.state === "completed_with_issues") {
      revalidatePath("/sources/add");
    }
    return batch;
  });
}

/** Confirms one reviewed item: the server issues a consent for the exact digest, then starts a one-item batch. */
export async function applyReviewedUpdateAction(input: {
  connectorId: string;
  idempotencyKey: string;
  planId: string;
  targetDigest: string;
}): Promise<UpdateActionResult<string>> {
  return await updateAction(async () => {
    const consentToken = parseConnectorUpdateConsentToken(
      await createConnectorUpdateConsent({
        connectorId: input.connectorId,
        planId: input.planId,
        targetDigest: input.targetDigest,
      })
    );
    return parseConnectorUpdateJobId(
      await createConnectorUpdateBatch({
        consentToken,
        idempotencyKey: input.idempotencyKey,
        planId: input.planId,
        selectedConnectorIds: [input.connectorId],
      }),
      "batch_id"
    );
  });
}
