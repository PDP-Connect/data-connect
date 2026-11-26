"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { installConnectorForSourceAction } from "./install-connector-action.ts";
import { ACTION_ERROR_COPY } from "./source-detail-copy.ts";

interface Props {
  /** Bare connector key the owner install route accepts (e.g. `chase`). */
  connectorKey: string;
  displayName: string;
  actionLabel?: string;
  /** Route id of this source page, so the action revalidates it. */
  routeId: string;
  /**
   * `notice`: the page-level banner shown before any run is attempted.
   * `inline`: the compact form the Sync button shows after a refused run.
   */
  variant: "inline" | "notice";
  /** Called after a successful install, so a parent holding this prompt can drop it. */
  onInstalled?: () => void;
}

type Feedback = { message: string; rawDetails?: string; tone: "error" | "success" } | null;

/**
 * Says that this source's connector is not installed and offers the one
 * action that fixes it. Installing is the owner's decision, so nothing runs
 * until the button is pressed; afterwards the page re-reads its state.
 */
export function ConnectorInstallPrompt({ actionLabel, connectorKey, displayName, onInstalled, routeId, variant }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);

  const install = useCallback(() => {
    setFeedback(null);
    startTransition(async () => {
      const result = await installConnectorForSourceAction(connectorKey, routeId);
      if (!result.ok) {
        setFeedback({ message: ACTION_ERROR_COPY, rawDetails: result.message, tone: "error" });
        return;
      }
      setFeedback({ message: "Ready. Refreshing…", tone: "success" });
      onInstalled?.();
      router.refresh();
    });
  }, [connectorKey, onInstalled, routeId, router]);

  const notice = variant === "notice";
  return (
    <div
      className={
        notice
          ? "grid min-w-0 gap-2 border-y border-border py-3 text-attention"
          : "grid min-w-0 gap-1.5"
      }
      data-connector-key={connectorKey}
      data-testid={notice ? "connector-not-installed-notice" : "connector-not-installed-inline"}
      role={notice ? "status" : undefined}
    >
      {notice ? <p className={`pdpp-caption min-w-0 break-words ${notice ? "font-medium" : "text-attention"}`}>
        {`DataConnect needs to get ${displayName} ready again.`}
      </p> : null}
      {notice ? (
        <p className="pdpp-caption min-w-0 break-words text-muted-foreground">Your records stay.</p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <IcButton
          data-testid="connector-install-action"
          disabled={isPending}
          onClick={install}
          size="sm"
          type="button"
          variant="default"
        >
          {isPending ? "Getting ready…" : actionLabel ?? `Get ${displayName} ready`}
        </IcButton>
        {feedback ? (
          <div
            aria-live="polite"
            className={`pdpp-caption min-w-0 break-words ${
              feedback.tone === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
            data-testid="connector-install-feedback"
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            <p>{feedback.message}</p>
            {feedback.rawDetails ? (
              <details className="mt-1 text-muted-foreground">
                <summary className="cursor-pointer">What went wrong</summary>
                <code className="mt-1 block break-words font-mono text-xs">{feedback.rawDetails}</code>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
