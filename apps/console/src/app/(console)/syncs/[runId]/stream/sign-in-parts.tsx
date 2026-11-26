// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { NoAssistanceRunPoller } from "./no-assistance-run-poller.tsx";
import type { ReactNode } from "react";
import { ConnectHeader } from "../../../sources/add/connect-parts.tsx";
import type { ConnectorContext } from "./connector-context-resolution.ts";

export function SignInMark() {
  return <a aria-label="DataConnect Home" className="absolute top-3 left-3 z-10 flex items-center gap-2 text-foreground" href="/"><img alt="" height={18} src="/brand/dataconnect-mark.svg" width={18} /><span className="pdpp-caption font-medium">DataConnect</span></a>;
}
export function SignInFrame({ children, connector, title, step = true }: { children?: ReactNode; connector: ConnectorContext | null; title: string; step?: boolean }) {
  return <main className="relative min-h-dvh"><SignInMark /><div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-5 py-16">{step ? <p className="pdpp-caption text-muted-foreground">Step 1 of 2: sign in</p> : null}<ConnectHeader connectorKey={connector?.connectorId ?? ""} icon={connector?.icon} name={connector?.displayName ?? "the data source"} title={title} />{children}</div></main>;
}

export function PreparingBrowserSurface({ connector, poll = true, runId }: { connector: ConnectorContext | null; poll?: boolean; runId: string }) {
  return <SignInFrame connector={connector} title={`Opening ${connector?.displayName ?? "the data source"}…`}>{poll ? <NoAssistanceRunPoller runId={runId} /> : null}<p className="text-muted-foreground">This can take a minute. Keep this page open; the sign-in page will appear here.</p></SignInFrame>;
}
export function ExternalApprovalSurface({ connector, message, poll = true, runId }: { connector: ConnectorContext | null; message: string; poll?: boolean; runId: string }) {
  return <SignInFrame connector={connector} title={`Approve the sign-in to ${connector?.displayName ?? "the data source"}`}>{poll ? <NoAssistanceRunPoller runId={runId} /> : null}<p className="text-muted-foreground">{message}</p><p className="text-muted-foreground">DataConnect carries on by itself once you approve. There is nothing to do on this page.</p></SignInFrame>;
}
