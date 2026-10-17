// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../../components/recordroom-shell-with-palette.tsx";
import {
  type ApprovalReview as ApprovalReviewData,
  getPendingApprovalReview,
  RefNotFoundError,
} from "../../../lib/ref-client.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
import { approveReviewedPendingApprovalAction, denyPendingApprovalAction } from "../../pending-actions.ts";
import { ApprovalReview } from "./approval-review.tsx";

export const dynamic = "force-dynamic";

export default async function ApprovalReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ approvalId: string }>;
  searchParams: Promise<{ approval_error?: string; confirm?: string }>;
}) {
  const [{ approvalId }, query] = await Promise.all([params, searchParams]);
  let detail: ApprovalReviewData;
  const connectorManifests = await listConnectorManifests().catch(() => []);
  const connectorIcons = Object.fromEntries(
    connectorManifests.flatMap((manifest) => [
      [manifest.connector_id, manifest.icon] as const,
      ...(manifest.connector_key ? ([[manifest.connector_key, manifest.icon]] as const) : []),
    ])
  );
  try {
    detail = await getPendingApprovalReview(approvalId);
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  }
  return (
    <RecordroomShellWithPalette>
      <ApprovalReview
        approveAction={approveReviewedPendingApprovalAction}
        confirm={!query.approval_error && query.confirm === "1"}
        connectorIcons={connectorIcons}
        denyAction={denyPendingApprovalAction}
        detail={detail}
        error={query.approval_error}
      />
    </RecordroomShellWithPalette>
  );
}
