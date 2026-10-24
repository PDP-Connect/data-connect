"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { useEffect, useState } from "react";
import { connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import type { ConnectorUpdateBatch, ConnectorUpdatePlan, ConnectorUpdatePlanItem } from "../../lib/connector-update-contract.ts";
import {
  applyReviewedUpdateAction,
  applyUpdatePlanAction,
  createUpdatePlanAction,
  getUpdateBatchAction,
  getUpdatePlanAction,
} from "./connector-update-actions.ts";
import { BatchResults, TERMINAL_BATCH_STATES } from "./connector-update-results.tsx";
import { useConnectorUpdateContext } from "./connector-update-context.tsx";
import { ReviewPanel } from "./connector-update-review.tsx";

const BATCH_STORAGE_KEY = "pdpp.connector-updates.batch-id";
const APPLY_STORAGE_KEY = "pdpp.connector-updates.pending-apply";
const POLL_MS = 1500;

interface PendingApply {
  idempotencyKey: string;
  planId: string;
}

function pendingApply(): PendingApply | null {
  try {
    const value = JSON.parse(localStorage.getItem(APPLY_STORAGE_KEY) ?? "null") as unknown;
    if (value && typeof value === "object" && "planId" in value && "idempotencyKey" in value) {
      const { planId, idempotencyKey } = value;
      if (typeof planId === "string" && typeof idempotencyKey === "string") {
        return { planId, idempotencyKey };
      }
    }
  } catch {
    localStorage.removeItem(APPLY_STORAGE_KEY);
  }
  return null;
}

export function ConnectorUpdatesHeader({ enabled = true }: { enabled?: boolean }) {
  const { setPlanState, setReviewRequiredIds } = useConnectorUpdateContext();
  const [plan, setPlan] = useState<ConnectorUpdatePlan | null>(null);
  const [batch, setBatch] = useState<ConnectorUpdateBatch | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [checking, setChecking] = useState(enabled);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planRevision, setPlanRevision] = useState(0);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setChecking(true);
    setPlanState("checking");
    setPlan(null);
    setReviewRequiredIds(new Set());
    let active = true;
    async function restoreBatch() {
      const storedBatchId = localStorage.getItem(BATCH_STORAGE_KEY);
      if (storedBatchId) {
        if (active) {
          setBatchId(storedBatchId);
        }
        return;
      }
      const pending = pendingApply();
      if (!pending) {
        return;
      }
      const resumed = await applyUpdatePlanAction(pending.planId, pending.idempotencyKey);
      localStorage.removeItem(APPLY_STORAGE_KEY);
      if (resumed.ok) {
        localStorage.setItem(BATCH_STORAGE_KEY, resumed.data);
        if (active) {
          setBatchId(resumed.data);
        }
      } else if (active) {
        setError(resumed.message);
      }
    }
    async function load() {
      if (planRevision === 0) {
        await restoreBatch();
      }
      const created = await createUpdatePlanAction();
      if (!active) {
        return;
      }
      if (!created.ok) {
        setChecking(false);
        setPlanState("failed");
        setError(created.message);
        return;
      }
      const planId = created.data;
      async function pollPlan() {
        const result = await getUpdatePlanAction(planId);
        if (!active) {
          return;
        }
        if (!result.ok) {
          setChecking(false);
          setPlanState("failed");
          setError(result.message);
          return;
        }
        if (result.data.state === "checking") {
          window.setTimeout(pollPlan, POLL_MS);
          return;
        }
        setChecking(false);
        if (result.data.state === "failed") {
          setPlanState("failed");
          setError(result.data.error ?? "The update check failed. Try again.");
          return;
        }
        setPlan(result.data);
        setPlanState("ready");
        setReviewRequiredIds(new Set(result.data.items.filter((item) => item.review_required).map((item) => connectorLookupKey(item.connector_id))));
      }
      await pollPlan();
    }
    load().catch((failure: unknown) => {
      if (active) {
        setPlanState("failed");
        setError(failure instanceof Error ? failure.message : "Could not check connector updates.");
      }
    });
    return () => {
      active = false;
    };
  }, [enabled, planRevision, setPlanState, setReviewRequiredIds]);

  useEffect(() => {
    if (!batchId) {
      return;
    }
    let active = true;
    async function pollBatch() {
      if (!batchId) {
        return;
      }
      const result = await getUpdateBatchAction(batchId);
      if (!active) {
        return;
      }
      if (!result.ok) {
        if (result.status === 404) {
          localStorage.removeItem(BATCH_STORAGE_KEY);
          setBatchId(null);
          setBatch(null);
          return;
        }
        setError(result.message);
        return;
      }
      setBatch(result.data);
      if (TERMINAL_BATCH_STATES.has(result.data.state)) {
        setPlanRevision((revision) => revision + 1);
      } else {
        window.setTimeout(pollBatch, POLL_MS);
      }
    }
    pollBatch().catch((failure: unknown) => {
      if (active) {
        setError(failure instanceof Error ? failure.message : "Could not read connector update results.");
      }
    });
    return () => {
      active = false;
    };
  }, [batchId]);

  async function apply() {
    if (!plan || applying || plan.manual_count === 0) {
      return;
    }
    setApplying(true);
    setError(null);
    const idempotencyKey = crypto.randomUUID();
    localStorage.setItem(APPLY_STORAGE_KEY, JSON.stringify({ planId: plan.plan_id, idempotencyKey }));
    const result = await applyUpdatePlanAction(plan.plan_id, idempotencyKey);
    setApplying(false);
    if (!result.ok) {
      localStorage.removeItem(APPLY_STORAGE_KEY);
      setError(result.message);
      return;
    }
    localStorage.setItem(BATCH_STORAGE_KEY, result.data);
    localStorage.removeItem(APPLY_STORAGE_KEY);
    setBatch(null);
    setBatchId(result.data);
  }

  async function confirmReview(item: ConnectorUpdatePlanItem) {
    if (!plan || applying) {
      return;
    }
    setApplying(true);
    setError(null);
    const result = await applyReviewedUpdateAction({
      connectorId: item.connector_id,
      idempotencyKey: crypto.randomUUID(),
      planId: plan.plan_id,
      targetDigest: item.target.digest,
    });
    setApplying(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    localStorage.setItem(BATCH_STORAGE_KEY, result.data);
    setReviewingId(item.connector_id);
    setBatch(null);
    setBatchId(result.data);
  }

  const reviewItems = plan?.items.filter((item) => item.review_required) ?? [];
  const batchFinished = batch && TERMINAL_BATCH_STATES.has(batch.state);
  const batchRunning = Boolean(batchId && !batchFinished);
  let buttonLabel = `Update all (${plan?.manual_count ?? 0})`;
  if (batchRunning) {
    buttonLabel = "Updating connectors…";
  } else if (checking) {
    buttonLabel = "Checking updates…";
  } else if (applying) {
    buttonLabel = "Starting updates…";
  }
  return (
    <>
      <PageHeader
        actions={
          enabled ? (
            <IcButton
              disabled={checking || applying || batchRunning || !plan?.manual_count}
              onClick={apply}
              size="sm"
              type="button"
            >
              {buttonLabel}
            </IcButton>
          ) : undefined
        }
        breadcrumbs={[
          { href: dashboardRoutes.section.overview, label: "Overview" },
          { href: dashboardRoutes.section.records, label: "Sources" },
          { label: "Add source" },
        ]}
        description="Add sources that populate this PDPP instance. App and local-client access is configured separately under Connect apps."
        meta={
          enabled && plan ? (
            <div className="pdpp-caption text-muted-foreground" role="status">
              {plan.manual_count} ready to update · {plan.review_count} need review
            </div>
          ) : undefined
        }
        title="Add source"
      />
      {error ? (
        <p className="pdpp-caption mb-5 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {batch ? <BatchResults batch={batch} reviewItems={reviewItems} /> : null}
      {batch ? null : (
        <ReviewPanel
          busyConnectorId={applying || batchRunning ? reviewingId : null}
          items={reviewItems}
          onConfirm={confirmReview}
        />
      )}
    </>
  );
}
