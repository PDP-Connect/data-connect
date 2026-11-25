"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { gettingReadyCopy } from "./connect-copy.ts";
import { installConnectorAction } from "./connector-install-actions.ts";
import { type GettingReadyOutcome, getServiceReady } from "./getting-ready.ts";
import { serviceReadinessAction } from "./service-ready-actions.ts";
import { WentWrong } from "./connect-parts.tsx";

export type GettingReadyView =
  | { readonly kind: "waiting" }
  | { readonly detail: string; readonly kind: "failed" };

/** What the person sees. Pure, so every state can be rendered in a test. */
export function GettingReadyBody({
  name,
  onRetry,
  view,
}: {
  name: string;
  onRetry: () => void;
  view: GettingReadyView;
}) {
  if (view.kind === "failed") {
    return (
      <div className="grid max-w-xl gap-3" data-testid="getting-ready-failed" role="alert">
        <p className="text-foreground">{gettingReadyCopy.failed(name)}</p>
        <div>
          <IcButton onClick={onRetry} size="sm" type="button" variant="default">
            {gettingReadyCopy.retry}
          </IcButton>
        </div>
        <WentWrong message={view.detail} />
      </div>
    );
  }
  return (
    <div className="grid max-w-xl gap-1" data-testid="getting-ready" role="status">
      <p className="text-foreground">{gettingReadyCopy.heading(name)}</p>
      <p className="pdpp-caption text-muted-foreground">{gettingReadyCopy.wait}</p>
    </div>
  );
}

/**
 * Gets the service ready without a click: calls the install action when the
 * service is not on this computer yet, waits until the server reports it ready,
 * then opens its connect form.
 */
export function GettingReady({
  connectorKey,
  install,
  name,
}: {
  connectorKey: string;
  /** Present only when the service has not been used on this computer yet. */
  install: { connectorId: string; digest: string } | null;
  name: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<GettingReadyView>({ kind: "waiting" });
  const [attempt, setAttempt] = useState(0);
  const started = useRef<number | null>(null);

  useEffect(() => {
    // One run per attempt; strict mode mounts twice and must not install twice.
    if (started.current === attempt) return;
    started.current = attempt;
    setView({ kind: "waiting" });
    void getServiceReady({
      check: () => serviceReadinessAction(connectorKey),
      install: () => (install ? installConnectorAction(install.connectorId, install.digest) : Promise.resolve({ ok: true as const })),
      needsInstall: install !== null,
    }).then((outcome: GettingReadyOutcome) => {
      if (outcome.kind === "ready") router.replace(outcome.href);
      else setView(outcome);
    });
  }, [attempt, connectorKey, install, router]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return <GettingReadyBody name={name} onRetry={retry} view={view} />;
}
