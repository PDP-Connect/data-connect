"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { type ConnectorInstallRowModel, connectorInstallTierLabel } from "../../lib/connector-install-presentation.ts";
import { installConnectorAction, updateConnectorAction } from "./connector-install-actions.ts";

function tierTone(tier: ConnectorInstallRowModel["tier"]): string {
  if (tier === "supported") {
    return "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg";
  }
  if (tier === "preview") {
    return "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg";
  }
  return "border-border bg-muted/30 text-muted-foreground";
}

function activationTone(state: ConnectorInstallRowModel["activationState"]): string {
  if (state === "active") {
    return "text-status-success-fg";
  }
  if (state === "update_available") {
    return "text-status-warning-fg";
  }
  return "text-muted-foreground";
}

export function ConnectorInstallRow({ model }: { model: ConnectorInstallRowModel }) {
  const { action, connectorId } = model;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    message: string;
    tone: "error" | "success";
  } | null>(null);
  const submit = useCallback(() => {
    if (!action) {
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result =
        action.kind === "install"
          ? await installConnectorAction(connectorId, action.digest)
          : await updateConnectorAction(connectorId);
      if (!result.ok) {
        setMessage({ message: result.message, tone: "error" });
        return;
      }
      setMessage({
        message:
          action.kind === "install" ? "Install complete. Refreshing status…" : "Update complete. Refreshing status…",
        tone: "success",
      });
      router.refresh();
    });
  }, [action, connectorId, router]);

  const idleLabel = action?.kind === "install" ? "Install" : "Update";
  let buttonLabel = idleLabel;
  if (isPending) {
    buttonLabel = action?.kind === "install" ? "Installing…" : "Updating…";
  }
  const feedbackClassName =
    message?.tone === "error" ? "pdpp-caption text-destructive" : "pdpp-caption text-status-success-fg";
  const feedbackRole = message?.tone === "error" ? "alert" : "status";
  return (
    <div
      className="mt-3 grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-2"
      data-connector-id={connectorId}
      data-testid="connector-install-row"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${tierTone(model.tier)}`}
          data-testid="connector-tier"
        >
          {connectorInstallTierLabel(model.tier)}
        </span>
        <span className={`pdpp-caption font-medium ${activationTone(model.activationState)}`}>
          Package: {model.activationLabel}
        </span>
      </div>
      <div className="pdpp-caption flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          Installed: {model.installedVersion ?? "—"}
          {model.installedDigest ? (
            <code className="ml-1 font-mono text-foreground" title="Installed package digest">
              {model.installedDigest}
            </code>
          ) : null}
        </span>
        {model.targetVersion ? <span>Target: {model.targetVersion}</span> : null}
      </div>
      {model.hostBlockReason ? (
        <p className="pdpp-caption text-status-warning-fg" data-testid="connector-host-block">
          Host blocked: {model.hostBlockReason}
        </p>
      ) : null}
      {action ? (
        <div className="flex flex-wrap items-center gap-2">
          <IcButton disabled={isPending} onClick={submit} size="sm" type="button">
            {buttonLabel}
          </IcButton>
          {message ? (
            <span aria-live="polite" className={feedbackClassName} role={feedbackRole}>
              {message.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
