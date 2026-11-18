"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Plain-words errors with the raw code one click away, and the collapsed
// Details block that holds host internals. Everything inside `Diagnostics`
// may show codes and flags; nothing outside it may.
import { createContext, useContext, useState, type ReactNode } from "react";
import { formatLocalTime } from "./plain-text.ts";
import { type ActionKind, GENERIC_ERROR, genericErrorFor, type PublicError, publicError } from "./reachability-errors.ts";

export const DiagnosticsContext = createContext<{ appVersion?: string }>({});

export type DisplayError = PublicError & {
  at: number;
  service?: string;
  // "load" errors clear when the next load succeeds; "action" errors stay until the next action.
  source: "load" | "action";
};

// An error a person caused or can fix, worded for them. The code stays in Details.
export class ReachabilityFailure extends Error {
  readonly detail: PublicError;
  constructor(detail: PublicError) {
    super(detail.message);
    this.detail = detail;
  }
}

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
    `Time: ${formatLocalTime(error.at)} (${new Date(error.at).toISOString()})`,
    `Service: ${error.service ?? "not chosen"}`,
    `App version: ${appVersion ?? "unknown"}`,
    ...(error.serverMessage ? [`Server message: ${error.serverMessage}`] : []),
  ].join("\n");
}

export function Diagnostics({ children, label = "Details" }: { children: ReactNode; label?: string }) {
  return (
    <details className="pdpp-caption grid gap-2" data-diagnostics="">
      <summary className="cursor-pointer">{label}</summary>
      <div className="grid gap-2">{children}</div>
    </details>
  );
}

export function ErrorNotice({ error }: { error: DisplayError }) {
  const { appVersion } = useContext(DiagnosticsContext);
  const [copied, setCopied] = useState(false);
  const text = diagnosticsText(error, appVersion);
  return (
    <div className="grid gap-1" role="alert">
      <p className="pdpp-caption text-destructive">{error.message}</p>
      <Diagnostics>
        <pre className="whitespace-pre-wrap break-words">{text}</pre>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </button>
      </Diagnostics>
    </div>
  );
}
