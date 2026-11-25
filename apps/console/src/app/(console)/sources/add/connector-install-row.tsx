"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { ConnectorInstallRowModel } from "../../lib/connector-install-presentation.ts";
import { installConnectorAction, uninstallConnectorAction, updateConnectorAction } from "./connector-install-actions.ts";

function activationTone(state: ConnectorInstallRowModel["activationState"]): string {
  if (state === "active") {
    return "text-muted-foreground";
  }
  if (state === "update_available") {
    return "text-status-warning-fg";
  }
  return "text-muted-foreground";
}

type ConnectorInstallRowPresentation = "full" | "primary-action" | "details-actions" | "uninstall-only";

export function ConnectorInstallRow({
  model,
  presentation = "full",
}: {
  model: ConnectorInstallRowModel;
  presentation?: ConnectorInstallRowPresentation;
}) {
  const compact = presentation !== "full";
  const showStatus = presentation === "full";
  const showDetails = presentation === "full";
  const showAction = presentation !== "uninstall-only";
  const showUninstall = presentation !== "primary-action";
  const { action, connectorId, connectorKey } = model;
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
  const uninstall = useCallback(() => {
    if (!window.confirm("Uninstall this package? This is allowed only when no data sources use it.")) return;
    setMessage(null);
    startTransition(async () => {
      const result = await uninstallConnectorAction(connectorKey);
      if (!result.ok) {
        setMessage({ message: result.message, tone: "error" });
        return;
      }
      setMessage({ message: "Uninstall complete. Refreshing status…", tone: "success" });
      router.refresh();
    });
  }, [connectorKey, router]);

  const idleLabel = action?.kind === "install" ? "Install" : "Update";
  let buttonLabel = idleLabel;
  if (isPending) {
    buttonLabel = action?.kind === "install" ? "Installing…" : "Updating…";
  }
  const feedbackClassName =
    message?.tone === "error" ? "pdpp-caption text-destructive" : "pdpp-caption text-muted-foreground";
  const feedbackRole = message?.tone === "error" ? "alert" : "status";
  return (
    <div
      className={compact ? "grid gap-2" : "mt-4 grid gap-2 border-t border-border/60 pt-3"}
      data-connector-id={connectorId}
      data-testid="connector-install-row"
    >
      {showStatus ? (
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
      ) : null}
      {showDetails && model.installedDigest ? (
        <details className="group">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Details
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
      {showDetails && model.hostBlockReason ? (
        <details className="group">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">Details</summary>
          <p className="pdpp-caption mt-1 text-status-warning-fg" data-testid="connector-host-block">Host blocked: {model.hostBlockReason}</p>
        </details>
      ) : null}
      {(showAction && action) || (showUninstall && model.installedDigest) ? (
        <div className="flex flex-wrap items-center gap-2">
          {showAction && action ? (
            <IcButton className="min-h-11 sm:min-h-[30px]" disabled={isPending} onClick={submit} size="sm" type="button" variant="ghost">
              {buttonLabel}
            </IcButton>
          ) : null}
          {showUninstall && model.installedDigest ? (
            <IcButton className="min-h-11 sm:min-h-[30px]" disabled={isPending} onClick={uninstall} size="sm" type="button" variant="destructive">
              {isPending ? "Uninstalling…" : "Uninstall"}
            </IcButton>
          ) : null}
          {message ? (
            <span aria-live="polite" className={feedbackClassName} role={feedbackRole}>
            {message.tone === "error" ? "Couldn't complete this action. Try again." : message.message}
            </span>
          ) : null}
        {message?.tone === "error" ? (
          <details className="group">
            <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">Details</summary>
            <p className="pdpp-caption mt-1 text-muted-foreground">{message.message}</p>
          </details>
        ) : null}
        </div>
      ) : null}
    </div>
  );
}
