"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { ConnectorInstallRowModel } from "../../lib/connector-install-presentation.ts";
import { installConnectorAction, updateConnectorAction } from "./connector-install-actions.ts";

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
      className="mt-4 grid gap-2 border-t border-border/60 pt-3"
      data-connector-id={connectorId}
      data-testid="connector-install-row"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`pdpp-caption font-medium ${activationTone(model.activationState)}`} data-testid="connector-package-status">
          {model.activationLabel}
        </span>
        {model.installedVersion ? (
          <span className="pdpp-caption text-muted-foreground">Installed v{model.installedVersion}</span>
        ) : null}
        {model.activationState === "update_available" && model.targetVersion ? (
          <span className="pdpp-caption text-status-warning-fg">Update to v{model.targetVersion}</span>
        ) : null}
        {model.activationState === "not_installed" && model.targetVersion ? (
          <span className="pdpp-caption text-muted-foreground">Available v{model.targetVersion}</span>
        ) : null}
      </div>
      {model.installedDigest ? (
        <details className="group">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Package details
          </summary>
          <div className="pdpp-caption mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            <span>
              Installed digest{" "}
              <code className="font-mono text-foreground" title={model.installedDigestFull ?? undefined}>
                {model.installedDigest}
              </code>
            </span>
            {model.targetVersion ? <span>Target v{model.targetVersion}</span> : null}
          </div>
        </details>
      ) : null}
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
