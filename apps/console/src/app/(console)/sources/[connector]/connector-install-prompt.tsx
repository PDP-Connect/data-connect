"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  connectorInstallActionLabel,
  connectorInstallExplainer,
  connectorInstallFailureCopy,
  connectorNotInstalledCopy,
} from "../../lib/connector-implementation.ts";
import { installConnectorForSourceAction } from "./install-connector-action.ts";

interface Props {
  /** Bare connector key the owner install route accepts (e.g. `chase`). */
  connectorKey: string;
  displayName: string;
  /** Route id of this source page, so the action revalidates it. */
  routeId: string;
  /**
   * `notice`: the page-level banner shown before any run is attempted.
   * `inline`: the compact form the Sync button shows after a refused run.
   */
  variant: "inline" | "notice";
}

type Feedback = { message: string; tone: "error" | "success" } | null;

/**
 * Says that this source's connector is not installed and offers the one
 * action that fixes it. Installing is the owner's decision, so nothing runs
 * until the button is pressed; afterwards the page re-reads its state.
 */
export function ConnectorInstallPrompt({ connectorKey, displayName, routeId, variant }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);

  const install = useCallback(() => {
    setFeedback(null);
    startTransition(async () => {
      const result = await installConnectorForSourceAction(connectorKey, routeId);
      if (!result.ok) {
        setFeedback({ message: connectorInstallFailureCopy(displayName, result.message), tone: "error" });
        return;
      }
      setFeedback({ message: "Installed. Refreshing…", tone: "success" });
      router.refresh();
    });
  }, [connectorKey, displayName, routeId, router]);

  const notice = variant === "notice";
  return (
    <div
      className={
        notice
          ? "grid min-w-0 gap-2 rounded-sm border border-status-warning-border bg-status-warning-bg p-3 text-status-warning-fg"
          : "grid min-w-0 gap-1.5"
      }
      data-connector-key={connectorKey}
      data-testid={notice ? "connector-not-installed-notice" : "connector-not-installed-inline"}
      role={notice ? "status" : undefined}
    >
      <p className={`pdpp-caption min-w-0 break-words ${notice ? "font-medium" : "text-status-warning-fg"}`}>
        {connectorNotInstalledCopy(displayName)}
      </p>
      {notice ? (
        <p className="pdpp-caption min-w-0 break-words text-muted-foreground">{connectorInstallExplainer(displayName)}</p>
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
          {isPending ? "Installing…" : connectorInstallActionLabel(displayName)}
        </IcButton>
        {feedback ? (
          <span
            aria-live="polite"
            className={`pdpp-caption min-w-0 break-words ${
              feedback.tone === "error" ? "text-destructive" : "text-status-success-fg"
            }`}
            data-testid="connector-install-feedback"
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
