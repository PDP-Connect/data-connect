"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteConnectionAction, resetAndSyncConnectionAction, revokeConnectionAction } from "./actions.ts";
import { ACTION_ERROR_COPY } from "./source-detail-copy.ts";

interface Props {
  /**
   * The in-flight run that blocks a delete, when known (from the delete
   * refusal or the connection's schedule). Enables "Cancel run and delete".
   */
  activeRunId?: string | null;
  /**
   * The concrete connection selector (`connection_id` / `connector_instance_id`).
   * Null only when this connector type has no addressable connection yet — the
   * danger zone renders disabled guidance in that case rather than destructive
   * forms with no target.
   */
  connectionId: string | null;
  /** Result banner forwarded from the server action redirect. */
  error?: string;
  /** Result banner forwarded from the server action redirect. */
  message?: string;
  /** Setup-failed shells have no collection state or authorization to revoke. */
  setupFailed?: boolean;
}

/**
 * Per-connection danger zone: confirmed Revoke and Delete controls. This
 * component renders only on the connection detail page, which resolves a
 * concrete configured connection (catalog-only / unavailable rows `notFound()`
 * before reaching it), so destructive controls never attach to a catalog row.
 *
 * Revoke is a lightweight confirm (checkbox); it stops future collection while
 * retaining records, grants, and audit. Delete requires reproducing the
 * connection id (typed-id confirmation) before the destructive submit enables;
 * it erases exactly this connection's records and is refused while a run is in
 * flight; when the blocking run is known, the same confirmed submit cancels it
 * and retries. Both confirmations are enforced again on the server — the client
 * gating is a guardrail, not the gate.
 */
export function ConnectionDangerZone({ activeRunId = null, connectionId, error, message, setupFailed = false }: Props) {
  return (
    <Section
      description="These actions affect this data source. Other data sources stay as they are."
      id="danger-zone"
      title="Remove or reset"
    >
      {error ? <ActionFeedback message={error} tone="error" /> : null}
      {message ? <ActionFeedback message={message} tone="success" /> : null}

      {connectionId === null ? (
        <p className="pdpp-caption text-muted-foreground italic">
          This data source has no ID yet, so there is nothing to disconnect or delete.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {setupFailed ? null : (
            <>
              <ResetSourceForm connectionId={connectionId} />
              <div aria-hidden className="border-border border-t" />
              <RevokeForm connectionId={connectionId} />
              <div aria-hidden className="border-border border-t" />
            </>
          )}
          <DeleteForm activeRunId={activeRunId} connectionId={connectionId} />
        </div>
      )}
    </Section>
  );
}

function ResetSourceForm({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pdpp-body font-medium">Sync again from the start</h3>
      <p className="pdpp-caption text-muted-foreground">
        Clears the saved sync position, then starts a full sync. Records and sign-in details are kept.
      </p>
      <label className="pdpp-caption flex items-center gap-2 text-muted-foreground">
        <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
        <span>Clear the saved sync position and start a full sync for this data source.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <IcButton
          disabled={!confirmed || isPending}
          className="text-destructive"
          onClick={() => {
            setMessage(null);
            startTransition(async () => {
              const result = await resetAndSyncConnectionAction(connectionId);
              if (result.ok) router.refresh();
              setMessage(
                result.ok
                  ? { text: "Sync state cleared. Full sync started.", tone: "success" }
                  : { text: result.message, tone: "error" }
              );
            });
          }}
          type="button"
          variant="ghost"
        >
          {isPending ? "Starting…" : "Sync again from the start"}
        </IcButton>
        {message ? (
            <ActionFeedback message={message.text} tone={message.tone} />
        ) : null}
      </div>
    </div>
  );
}

function RevokeForm({ connectionId }: { connectionId: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pdpp-body font-medium">Disconnect</h3>
      <p className="pdpp-caption text-muted-foreground">
        Stops future syncing and signs out its saved browser session. Your records, app access, and activity history are kept.
      </p>
      <form action={revokeConnectionAction} className="mt-1 flex flex-wrap items-center gap-3">
        <input name="connection_id" type="hidden" value={connectionId} />
        <label className="pdpp-caption flex items-center gap-2 text-muted-foreground">
          <input name="confirm_revoke" type="checkbox" value="yes" />
          <span>
            Stop future syncing for this data source; keep its records.
          </span>
        </label>
        <IcButton className="text-destructive" type="submit" variant="ghost">
          Disconnect
        </IcButton>
      </form>
    </div>
  );
}

function DeleteForm({ activeRunId, connectionId }: { activeRunId: string | null; connectionId: string }) {
  const [typed, setTyped] = useState("");
  const confirmed = typed === connectionId;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pdpp-body font-medium">Delete</h3>
      <p className="pdpp-caption text-muted-foreground">
        Permanently erases this data source's records, its sync position, and its saved browser session. This cannot be undone.
      </p>
      <p className="pdpp-caption text-muted-foreground">
        Apps that can read your data stay authorized. They keep any copies they already received.
      </p>
      {activeRunId ? (
        <p className="pdpp-caption text-muted-foreground">
          A sync is in progress. Deleting cancels it first; its saved records are erased with the rest.
        </p>
      ) : null}
      <form action={deleteConnectionAction} className="mt-1 flex flex-col gap-2">
        <input name="connection_id" type="hidden" value={connectionId} />
        {activeRunId ? <input name="cancel_run_id" type="hidden" value={activeRunId} /> : null}
        <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground" htmlFor="confirm-delete-input">
          <span>Type this ID to confirm: {connectionId}</span>
          <IcInput
            aria-label="Type the data source ID to confirm deletion"
            autoComplete="off"
            className="w-full max-w-md"
            id="confirm-delete-input"
            name="confirm_delete"
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Data source ID"
            value={typed}
          />
        </label>
        <div>
          <IcButton className="text-destructive" disabled={!confirmed} type="submit" variant="ghost">
            {activeRunId ? "Cancel sync and delete" : "Delete data source and erase its records"}
          </IcButton>
        </div>
      </form>
    </div>
  );
}

function ActionFeedback({ message, tone }: { message: string; tone: "error" | "success" }) {
  if (tone === "error") {
    return (
      <div className="mb-3 text-sm" role="alert">
        <p className="text-destructive">{ACTION_ERROR_COPY}</p>
        <details className="mt-1 text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <code className="mt-1 block break-words font-mono text-xs">{message}</code>
        </details>
      </div>
    );
  }
  return <p aria-live="polite" className="mb-3 text-sm text-muted-foreground" role="status">{message}</p>;
}
