// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { RecordroomShellWithPalette } from "../../../components/recordroom-shell-with-palette.tsx";
import { RunInteractionForm } from "../interaction-form.tsx";
import type { CredentialInteractionField } from "../credential-interaction.ts";
import { NoAssistanceRunPoller } from "./no-assistance-run-poller.tsx";
import type { ReactNode } from "react";
import { ConnectHeader, ConnectWorkingMark } from "../../../sources/add/connect-parts.tsx";
import type { ConnectorContext } from "./connector-context-resolution.ts";

export function SignInFrame({ children, connector, title, step = true }: { children?: ReactNode; connector: ConnectorContext | null; title: string; step?: boolean }) {
  return <RecordroomShellWithPalette><ConnectHeader connectorKey={connector?.connectorId ?? ""} icon={connector?.icon} name={connector?.displayName ?? "the data source"} title={title} step={step ? "Step 1 of 2: sign in" : undefined} /><div className="grid max-w-xl gap-4">{children}</div></RecordroomShellWithPalette>;
}

export function PreparingBrowserSurface({ connector, poll = true, runId }: { connector: ConnectorContext | null; poll?: boolean; runId: string }) {
  return <SignInFrame connector={connector} title={`Opening ${connector?.displayName ?? "the data source"}…`}><ConnectWorkingMark label="Opening" />{poll ? <NoAssistanceRunPoller runId={runId} /> : null}<p className="text-muted-foreground">This can take a minute. Keep this page open; the sign-in page will appear here.</p></SignInFrame>;
}
export function ExternalApprovalSurface({ connector, message, poll = true, runId }: { connector: ConnectorContext | null; message: string; poll?: boolean; runId: string }) {
  return <SignInFrame connector={connector} title={`Approve the sign-in to ${connector?.displayName ?? "the data source"}`}>{poll ? <NoAssistanceRunPoller runId={runId} /> : null}<p className="text-muted-foreground">{message}</p><p className="text-muted-foreground">DataConnect carries on by itself once you approve. There is nothing to do on this page.</p></SignInFrame>;
}

export function SignInDetailsSurface({ connector, fields, message, interactionId, runId, preview = false, previewError }: { connector: ConnectorContext | null; fields: CredentialInteractionField[]; message: string; interactionId: string; runId: string; preview?: boolean; previewError?: string }) {
  return <SignInFrame connector={connector} title={`${connector?.displayName ?? "The data source"} needs your sign-in details`}><RunInteractionForm fields={fields} heading={false} interactionId={interactionId} kind="credentials" message={message} preview={preview} previewError={previewError} returnHref={`/syncs/${encodeURIComponent(runId)}/stream`} runId={runId} serviceName={connector?.displayName} /></SignInFrame>;
}
