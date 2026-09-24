"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  revokeAllOwnerSessionsAction,
  revokeOtherOwnerSessionsAction,
  revokeOwnerBearerAction,
  revokeOwnerSessionAction,
} from "./owner-sessions-actions.ts";
import type { OwnerBearerView, OwnerSessionView } from "./owner-sessions-data.ts";

interface OwnerSessionsSettingProps {
  sessions: OwnerSessionView[];
  bearers: OwnerBearerView[];
}

function formatTimestamp(value: number | string): string {
  const milliseconds = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "Unknown time";
  return `${new Date(milliseconds).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function OwnerSessionsSetting({ sessions, bearers }: OwnerSessionsSettingProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <p className="pdpp-caption text-muted-foreground">
        These devices and command-line tools can access this Personal Server. Signing one out takes effect immediately.
      </p>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-foreground">Devices and browsers</h3>
          <div className="flex flex-wrap gap-2">
            {otherSessionCount > 0 ? (
              <button
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={() => void runAction(revokeOtherOwnerSessionsAction)}
                type="button"
              >
                Sign out other devices
              </button>
            ) : null}
            {sessions.length > 0 ? (
              <button
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={() => void runAction(revokeAllOwnerSessionsAction)}
                type="button"
              >
                Sign out all devices
              </button>
            ) : null}
          </div>
        </div>
        {sessions.length === 0 ? <p className="pdpp-caption text-muted-foreground">No devices are signed in.</p> : null}
        {sessions.map(session => (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-3" key={session.id}>
            <div className="grid min-w-0 gap-1">
              <p className="text-sm font-medium text-foreground">
                {session.label}
                {session.current ? <span className="ml-2 text-xs font-normal text-muted-foreground">Current session</span> : null}
              </p>
              <p className="pdpp-caption text-muted-foreground">
                Started {formatTimestamp(session.createdAt)} · Last seen {formatTimestamp(session.lastSeenAt)}
              </p>
              <p className="pdpp-caption text-muted-foreground">IP address: {session.ipAddress ?? "Unavailable"}</p>
            </div>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              disabled={busy}
              onClick={() => void runAction(() => revokeOwnerSessionAction(session.id))}
              type="button"
            >
              Sign out
            </button>
          </div>
        ))}
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium text-foreground">Command-line access</h3>
        {bearers.length === 0 ? <p className="pdpp-caption text-muted-foreground">No owner tokens are active.</p> : null}
        {bearers.map(bearer => (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-3" key={bearer.id}>
            <div className="grid min-w-0 gap-1">
              <p className="text-sm font-medium text-foreground">{bearer.label}</p>
              <p className="pdpp-caption text-muted-foreground">Created {formatTimestamp(bearer.createdAt)}</p>
              <p className="pdpp-caption text-muted-foreground">
                Expires {bearer.expiresAt ? formatTimestamp(bearer.expiresAt) : "Never"}
              </p>
            </div>
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              disabled={busy}
              onClick={() => void runAction(() => revokeOwnerBearerAction(bearer.id))}
              type="button"
            >
              Revoke token
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
