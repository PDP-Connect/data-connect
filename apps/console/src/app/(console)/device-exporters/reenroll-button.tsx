"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { SupportCopy } from "../components/support-copy.tsx";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { formatRelative } from "@pdpp/display";
import { useActionState } from "react";
import { pdppLocalCollectorEnrollCommand, pdppLocalCollectorRunCommand } from "@/lib/pdpp-cli-command.ts";
import { createEnrollmentCodeAction } from "./actions.ts";

function relativeExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, Date.now());
}

/**
 * Inline re-enrollment panel for a stale or revoked local device.
 *
 * Mirrors the Tailscale key-renewal pattern: clicking "Re-enroll" generates a
 * fresh enrollment code pre-scoped to the device's known connector_id and
 * local_binding_name, then renders the `pdpp collector enroll` command inline.
 *
 * This is a repair-path affordance only — shown on stale/revoked device rows.
 * Initial enrollment goes through the full EnrollmentForm on this page.
 *
 * Zero server changes: the existing POST /_ref/device-exporters/enrollment-codes
 * endpoint already handles this; we're just pre-filling it from known device data.
 */
export function ReenrollButton({
  connectorId,
  localBindingName,
  referenceBaseUrl,
}: {
  connectorId: string;
  localBindingName: string;
  referenceBaseUrl: string;
}) {
  const [state, formAction, pending] = useActionState(createEnrollmentCodeAction, { ok: null });

  if (state.ok === true) {
    const enrollCommand = pdppLocalCollectorEnrollCommand({
      baseUrl: referenceBaseUrl,
      code: state.code.enrollment_code,
      deviceLabel: state.deviceLabel,
    });

    const runCommand = pdppLocalCollectorRunCommand({ baseUrl: referenceBaseUrl, connectorId });
    const fullRunCommand = [
      "PDPP_LOCAL_DEVICE_ID=<device_id> \\",
      "PDPP_LOCAL_DEVICE_TOKEN=<device_token> \\",
      "PDPP_CONNECTION_ID=<source_instance_id> \\",
      runCommand,
    ].join("\n");

    return (
      <div className="mt-3 space-y-3 rounded-md border border-border/80 bg-background/60 p-3">
        <div className="pdpp-eyebrow text-muted-foreground">New setup code ready</div>

        <div>
          <div className="pdpp-eyebrow text-muted-foreground">1. Set up this device again</div>
          <p className="pdpp-caption mt-1 text-muted-foreground">
            Run on the target device. The response returns <code className="font-mono">device_id</code>,{" "}
            <code className="font-mono">device_token</code>, and <code className="font-mono">source_instance_id</code> —
            save all three, and never log the token.
          </p>
          <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
            <code
              className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground"
              data-testid="reenroll-enroll-command"
            >
              {enrollCommand}
            </code>
            <CopyButton ariaLabel="Copy re-enroll command" value={enrollCommand} />
          </div>
          <p className="pdpp-caption mt-1 text-muted-foreground">Expires {relativeExpiry(state.code.expires_at)}</p>
        </div>

        <div>
          <div className="pdpp-eyebrow text-muted-foreground">2. Start collection</div>
          <div className="rounded-md border border-border/70 bg-muted/30 p-3">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <div className="pdpp-caption text-muted-foreground">
                <code className="font-mono">{connectorId}</code>
              </div>
              <CopyButton ariaLabel="Copy collector run command" value={fullRunCommand} />
            </div>
            <pre
              className="pdpp-caption mt-2 min-w-0 overflow-x-auto whitespace-pre font-mono text-foreground"
              data-testid="reenroll-run-command"
            >
              {fullRunCommand}
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3">
      {state.ok === false ? (
        <div className="mb-2">
          <p className="pdpp-caption text-destructive">Could not make a new setup code. Try again.</p>
          <SupportCopy details={state.message} />
        </div>
      ) : null}
      <form action={formAction}>
        <input name="connector_id" type="hidden" value={connectorId} />
        <input name="display_name" type="hidden" value="" />
        <input name="expires_in_seconds" type="hidden" value="900" />
        <input name="local_binding_name" type="hidden" value={localBindingName} />
        <IcButton
          variant="ghost"
          size="sm"
          disabled={pending}
          type="submit"
        >
          {pending ? "Generating…" : "Set up again"}
        </IcButton>
      </form>
    </div>
  );
}
