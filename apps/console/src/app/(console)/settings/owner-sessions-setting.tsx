"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatRelative } from "@pdpp/display";
import {
  revokeAllOwnerSessionsAction,
  revokeOtherOwnerSessionsAction,
  revokeOwnerBearerAction,
  revokeOwnerSessionAction,
} from "./owner-sessions-actions.ts";
import type { OwnerBearerView, OwnerSessionView } from "./owner-sessions-data.ts";

interface OwnerSessionsSettingProps {
  bearersOnly?: boolean;
  sessions: OwnerSessionView[];
  bearers: OwnerBearerView[];
}

function formatTimestamp(value: number | string): string {
  const milliseconds = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "Unknown time";
  return formatRelative(new Date(milliseconds), Date.now());
}

export function OwnerSessionsSetting({ sessions, bearers, bearersOnly = false }: OwnerSessionsSettingProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<string | null>(null);
  const otherSessionCount = sessions.filter(session => !session.current).length;

  const runAction = async (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.message ?? "Could not update owner access.");
        return;
      }
      router.refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6">
      {error ? (
        <div role="alert">
          <p className="text-[13px] text-destructive">This could not be done. Try again.</p>
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground">Details</summary>
            <p className="break-words font-mono text-[12px] text-muted-foreground">{error}</p>
          </details>
        </div>
      ) : null}

      {bearersOnly ? null : <div className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3 py-2">
          <h3 className="text-[13px] font-medium text-muted-foreground">Devices and browsers</h3>
          <div className="flex flex-wrap gap-2">
            {otherSessionCount > 0 ? (
              <button
                className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy}
                onClick={() => setConfirmingAction("others")}
                type="button"
              >
                Sign out other devices
              </button>
            ) : null}
            {sessions.length > 0 ? (
              <button
                className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={busy}
                onClick={() => setConfirmingAction("all")}
                type="button"
              >
                Sign out all devices
              </button>
            ) : null}
          </div>
        </div>
        {confirmingAction === "others" || confirmingAction === "all" ? (
          <div aria-labelledby="session-confirmation" className="grid gap-2 border-b border-border/70 py-3" role="alertdialog">
            <p className="text-[13px] text-foreground" id="session-confirmation">
              {confirmingAction === "others"
                ? "Sign out the other devices? They will need to sign in again."
                : "Sign out all devices, including this one? You will need to sign in again."}
            </p>
            <div className="flex flex-wrap gap-2">
              <button className="min-h-11 rounded-[6px] px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => void runAction(confirmingAction === "others" ? revokeOtherOwnerSessionsAction : revokeAllOwnerSessionsAction)} type="button">
                Confirm sign out
              </button>
              <button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirmingAction(null)} type="button">
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {sessions.length === 0 ? <p className="pdpp-caption text-muted-foreground">No devices are signed in.</p> : null}
        {sessions.map(session => (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-border/70 py-3" key={session.id}>
            <div className="grid min-w-0 gap-1">
              <p className="text-[15px] font-medium text-foreground">
                {session.label}
                {session.current ? <span className="ml-2 text-[13px] font-normal text-muted-foreground">Current</span> : null}
              </p>
              <p className="text-[13px] text-muted-foreground">
                Last seen {formatTimestamp(session.lastSeenAt)}
              </p>
              <details className="text-[13px] text-muted-foreground">
                <summary className="min-h-11 cursor-pointer">Details</summary>
                <p>Started {formatTimestamp(session.createdAt)} · IP address: {session.ipAddress ?? "Unavailable"}</p>
              </details>
            </div>
            <button
              className="min-h-11 self-start rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={busy}
              onClick={() => setConfirmingAction(`session:${session.id}`)}
              type="button"
            >
              Sign out
            </button>
            {confirmingAction === `session:${session.id}` ? (
              <div aria-labelledby={`session-confirmation-${session.id}`} className="col-span-full grid gap-2 border-t border-border/70 pt-3" role="alertdialog">
                <p className="text-[13px] text-foreground" id={`session-confirmation-${session.id}`}>Sign out this device? It will need to sign in again.</p>
                <div className="flex flex-wrap gap-2">
                  <button className="min-h-11 rounded-[6px] px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => void runAction(() => revokeOwnerSessionAction(session.id))} type="button">Confirm sign out</button>
                  <button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirmingAction(null)} type="button">Cancel</button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>}

      <div className="grid gap-1">
        <h3 className="py-2 text-[13px] font-medium text-muted-foreground">Apps and scripts signed in as you</h3>
        {bearers.length === 0 ? <p className="py-2 text-[13px] text-muted-foreground">No apps or scripts are signed in as you.</p> : null}
        {bearers.map(bearer => (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-border/70 py-3" key={bearer.id}>
            <div className="grid min-w-0 gap-1">
              <p className="text-[15px] font-medium text-foreground">{bearer.label}</p>
              <p className="text-[13px] text-muted-foreground">Created {formatTimestamp(bearer.createdAt)}</p>
              <p className="text-[13px] text-muted-foreground">
                Expires {bearer.expiresAt ? formatTimestamp(bearer.expiresAt) : "Never"}
              </p>
            </div>
            <button
              className="min-h-11 self-start rounded-[6px] border border-border px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={busy}
              onClick={() => setConfirmingAction(`bearer:${bearer.id}`)}
              type="button"
            >
              Revoke access token
            </button>
            {confirmingAction === `bearer:${bearer.id}` ? (
              <div aria-labelledby={`bearer-confirmation-${bearer.id}`} className="col-span-full grid gap-2 border-t border-border/70 pt-3" role="alertdialog">
                <p className="text-[13px] text-foreground" id={`bearer-confirmation-${bearer.id}`}>Revoke this access token? It will stop working.</p>
                <div className="flex flex-wrap gap-2">
                  <button className="min-h-11 rounded-[6px] px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => void runAction(() => revokeOwnerBearerAction(bearer.id))} type="button">Confirm revoke</button>
                  <button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirmingAction(null)} type="button">Cancel</button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
