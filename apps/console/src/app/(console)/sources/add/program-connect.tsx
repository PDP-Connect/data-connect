"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { programCopy } from "./connect-copy.ts";
import { StartFailed } from "./connect-parts.tsx";
import { createProgramCommandAction, programCheckedInAction } from "./program-actions.ts";

const CHECK_IN_INTERVAL_MS = 3000;

export type ProgramView =
  | { readonly kind: "preparing" }
  | { readonly command: string; readonly issuedAt: string; readonly kind: "waiting" }
  | { readonly command: string; readonly kind: "checked-in" }
  | { readonly kind: "failed"; readonly message: string };

/** What the person sees for a program they run themselves. Pure, so every state renders in a test. */
export function ProgramConnectBody({ name, onRetry, view }: { name: string; onRetry: () => void; view: ProgramView }) {
  return (
    <div className="grid max-w-2xl gap-4" data-testid="program-connect">
      <p className="text-foreground">{programCopy.lead}</p>
      {view.kind === "failed" ? (
        <>
          <StartFailed message={view.message} sentence="The command could not be made. Try again." />
          <div>
            <IcButton onClick={onRetry} size="sm" type="button" variant="default">
              Try again
            </IcButton>
          </div>
        </>
      ) : null}
      {view.kind === "waiting" || view.kind === "checked-in" ? (
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
          <code className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground" data-testid="program-command">
            {view.command}
          </code>
          <CopyButton ariaLabel="Copy the command" value={view.command} />
        </div>
      ) : null}
      {view.kind === "waiting" ? (
        <p className="pdpp-caption text-muted-foreground" role="status">{programCopy.waiting}</p>
      ) : null}
      {view.kind === "checked-in" ? (
        <p className="pdpp-caption text-foreground" role="status">
          {programCopy.checkedIn(name)}{" "}
          <Link className="underline underline-offset-2" href="/sources">{programCopy.seeData}</Link>
        </p>
      ) : null}
    </div>
  );
}

export function ProgramConnect({ connectorKey, name }: { connectorKey: string; name: string }) {
  const [view, setView] = useState<ProgramView>({ kind: "preparing" });
  const [attempt, setAttempt] = useState(0);
  const started = useRef<number | null>(null);

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    setView({ kind: "preparing" });
    void createProgramCommandAction(connectorKey).then((result) => {
      setView(result.ok ? { command: result.command, issuedAt: result.issuedAt, kind: "waiting" } : { kind: "failed", message: result.message });
    });
  }, [attempt, connectorKey]);

  useEffect(() => {
    if (view.kind !== "waiting") return;
    const { command, issuedAt } = view;
    const timer = window.setInterval(() => {
      void programCheckedInAction(connectorKey, issuedAt)
        .then((seen) => {
          if (seen) setView({ command, kind: "checked-in" });
        })
        .catch(() => undefined);
    }, CHECK_IN_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connectorKey, view]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return <ProgramConnectBody name={name} onRetry={retry} view={view} />;
}
