// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { flowPreview, previewBrowserMessage } from "../../../connect/flow-preview.ts";
import { ExternalApprovalSurface, PreparingBrowserSurface, SignInDetailsSurface } from "./sign-in-parts.tsx";
import { ResolvedSurface, StreamSurface } from "./stream-viewer.tsx";
import { setupStatusHref } from "./sign-in-flow.ts";
export function SignInPreview({ state }: { state: string }) {
  const runId = flowPreview.runId;
  if (state === "signed-in") return <ResolvedSurface connector={flowPreview.connector} preview runId={runId} statusHref={setupStatusHref(flowPreview.connectionId, runId)} />;
  if (state.startsWith("needs-details")) return <SignInDetailsSurface connector={flowPreview.connector} fields={flowPreview.fields.map(field => ({ ...field, autocomplete: null }))} interactionId="sample-step" message={previewBrowserMessage(state)} preview previewError={state === "needs-details-rejected" ? flowPreview.detailsRejected : undefined} runId={runId} />;
  if (state === "opening") return <PreparingBrowserSurface connector={flowPreview.connector} poll={false} runId={runId} />;
  if (state === "approve") return <ExternalApprovalSurface connector={flowPreview.connector} poll={false} message={previewBrowserMessage(state)} runId={runId} />;
  return <StreamSurface connector={flowPreview.connector} interactionId="sample-step" interactionKind={state === "browser-step" ? "manual_action" : "otp"} interactionMessage={previewBrowserMessage(state)} interactionRequiresResponse pollForResolution={false} previewState={state} runId={runId} />;
}
