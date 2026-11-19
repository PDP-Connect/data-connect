"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Plain-words errors with the raw code one click away, and the collapsed
// Details block that holds host internals. Everything inside `Diagnostics`
// may show codes and flags; nothing outside it may.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { formatLocalTime } from "./plain-text.ts";
import { type ButtonKind, recoveryFor } from "./failure-recovery.ts";
import type { requestReachability } from "./reachability-actions.ts";
import {
  type ActionKind,
  GENERIC_ERROR,
  genericErrorFor,
  type PublicError,
  publicError,
  ReachabilityFailure,
} from "./reachability-errors.ts";

export { ReachabilityFailure };

export const DiagnosticsContext = createContext<{ appVersion?: string }>({});

// What an error's button may do on this card. A button with no handler is not shown.
export type Recover = {
  request: typeof requestReachability;
  onTryAgain: () => void;
  onTryAnotherWay: () => void;
  // Reads the host again and prepares again, with no page reload.
  onRefresh: () => void;
};
export const RecoveryContext = createContext<Recover | null>(null);

export type DisplayError = PublicError & {
  at: number;
  service?: string;
  // "load" errors clear when the next load succeeds; "action" errors stay until the next action.
  source: "load" | "action";
};

// An error a person caused or can fix, worded for them. The code stays in Details.

export function toDisplayError(
  failure: unknown,
  source: DisplayError["source"],
  service?: string,
  action: ActionKind = "turn-on"
): DisplayError {
  const base =
    failure instanceof ReachabilityFailure
      ? failure.detail
      : {
          ...publicError("client_error"),
          message: GENERIC_ERROR,
          ...(failure instanceof Error && failure.message ? { serverMessage: failure.message } : {}),
        };
  // The fallback sentence was fixed before we knew the action. Say the right one.
  const message = base.message === GENERIC_ERROR ? genericErrorFor(action) : base.message;
  return { ...base, message, at: Date.now(), source, ...(service ? { service } : {}) };
}

export function diagnosticsText(error: DisplayError, appVersion?: string): string {
  return [
    `Code: ${error.code}`,
    `Time: ${formatLocalTime(error.at)}`,
    `Service: ${error.service ?? "not chosen"}`,
    `App version: ${appVersion ?? "unknown"}`,
    ...(error.serverMessage ? [`Server message: ${error.serverMessage}`] : []),
  ].join("\n");
}

export function Diagnostics({ children, label = "Details", note }: { children: ReactNode; label?: string; note?: string }) {
  return (
    <details className="grid gap-2" data-diagnostics="">
      <summary className="cursor-pointer text-sm text-muted-foreground underline-offset-4 hover:underline">
        {note ? (
          <span className="flex flex-wrap items-center justify-between gap-3">
            <span className="pdpp-caption">{note}</span>
            <span className="flex-none text-sm">
              {label}{" "}
              <span aria-hidden="true">›</span>
            </span>
          </span>
        ) : (
          label
        )}
      </summary>
      <div className="grid gap-2">{children}</div>
    </details>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      type="button"
      variant="outline"
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

type PathReport = { paths: { path: string; fixable: boolean }[]; command: string | null };

// A folder the service refuses because others can write to it. The host repairs
// the ones inside DataConnect's own directory; for any other it shows the command.
function StatePathsFix({ recover }: { recover: Recover }) {
  const [report, setReport] = useState<PathReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { request } = recover;
  useEffect(() => {
    let active = true;
    void request("/state-paths").then((result) => {
      if (active && result.ok) setReport(result.data as PathReport);
    });
    return () => {
      active = false;
    };
  }, [request]);
  const fixable = report?.paths.some((item) => item.fixable) ?? false;
  async function fix() {
    setBusy(true);
    setFailed(null);
    try {
      const result = await request("/state-paths/fix", {});
      if (!result.ok) {
        setFailed("Couldn't change the permissions. Try the command below, or copy the details for support.");
        return;
      }
      const after = result.data as PathReport;
      if (after.paths.length === 0) recover.onRefresh();
      else setReport(after);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2">
      {fixable ? (
        <Button disabled={busy} onClick={() => void fix()} type="button">
          Fix permissions
        </Button>
      ) : null}
      {report?.command ? (
        <>
          <p className="pdpp-caption">{fixable ? "Others need a command from you. Run it, then try again:" : "Run this command, then try again:"}</p>
          <code className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm break-all">{report.command}</code>
          <div className="flex flex-wrap gap-3">
            <CopyButton label="Copy command" text={report.command} />
            {fixable ? null : (
              <Button onClick={recover.onRefresh} type="button" variant="outline">
                Try again
              </Button>
            )}
          </div>
        </>
      ) : null}
      {failed ? <p className="pdpp-caption">{failed}</p> : null}
    </div>
  );
}

const handlerFor = (kind: ButtonKind, recover: Recover): (() => void) | null =>
  kind === "try-again" ? recover.onTryAgain : kind === "try-another-way" ? recover.onTryAnotherWay : kind === "review" ? recover.onRefresh : null;

export function ErrorNotice({ error, action = "turn-on" }: { error: DisplayError; action?: ActionKind }) {
  const { appVersion } = useContext(DiagnosticsContext);
  const recover = useContext(RecoveryContext);
  const text = diagnosticsText(error, appVersion);
  const recovery = recoveryFor(error.code, action);
  const copyOutside = recovery.buttons.some((button) => button.kind === "copy-diagnostics");
  const actions = recovery.buttons.filter((button) => button.kind !== "copy-diagnostics");
  return (
    <div className="grid gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4" data-status={recovery.status} role="alert">
      {recovery.status === "needs-action" ? (
        <p className="flex items-center gap-2 text-sm font-medium">
          <span aria-hidden="true" className="size-2.5 flex-none rounded-full bg-amber-500 ring-4 ring-amber-500/15" />
          Needs your action
        </p>
      ) : null}
      <p className="text-sm text-destructive">{error.message}</p>
      {recover && recovery.buttons.some((button) => button.kind === "fix-permissions") ? <StatePathsFix recover={recover} /> : null}
      <div className="flex flex-wrap gap-3">
        {copyOutside ? <CopyButton label="Copy diagnostics" text={text} /> : null}
        {actions.map((button, index) => {
          const run = recover ? handlerFor(button.kind, recover) : null;
          return run ? (
            <Button key={button.kind} onClick={run} type="button" variant={index === 0 ? "default" : "outline"}>
              {button.label}
            </Button>
          ) : null;
        })}
      </div>
      <Diagnostics label={copyOutside ? "Details for support" : "Details"}>
        <pre className="whitespace-pre-wrap break-words">{text}</pre>
        {copyOutside ? null : <CopyButton label="Copy diagnostics" text={text} />}
      </Diagnostics>
    </div>
  );
}
