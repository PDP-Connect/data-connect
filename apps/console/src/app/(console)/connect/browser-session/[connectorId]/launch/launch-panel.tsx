"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, type ConnectorIconLike } from "@pdpp/brand-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ConnectHeader, WentWrong } from "../../../../sources/add/connect-parts.tsx";
import { flowPreview } from "../../../flow-preview.ts";

interface LaunchState {
  error: string | null;
  networkLost: boolean;
  starting: boolean;
}

interface LaunchResponse {
  href?: string;
  message?: string;
  run_id?: string;
}

const LOST_TRANSPORT_RE = /Failed to fetch|NetworkError|ERR_NETWORK_CHANGED/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLostTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return LOST_TRANSPORT_RE.test(message);
}

async function recoverStartedBrowserRun(
  connectorId: string,
  connectionId: string,
  attempts = 1
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      // Backoff delay between retries of the same recovery request; the
      // whole point is to wait between sequential attempts, not run them
      // concurrently.
      // biome-ignore lint/performance/noAwaitInLoops: see comment above.
      await delay(400);
    }
    try {
      const params = new URLSearchParams({ connection_id: connectionId });
      const response = await fetch(
        `/connect/browser-session/${encodeURIComponent(connectorId)}/launch/recover?${params.toString()}`,
        { credentials: "same-origin" }
      );
      if (response.status === 404) {
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as LaunchResponse;
      if (response.ok && body.href) {
        return body.href;
      }
    } catch {
      // Recovery is best-effort. A later attempt may succeed after Docker
      // networking settles from starting the browser surface.
    }
  }
  return null;
}

async function postStartBrowserRun(connectorId: string, connectionId: string, draft: boolean): Promise<string> {
  const response = await fetch(`/connect/browser-session/${encodeURIComponent(connectorId)}/launch/start`, {
    body: new URLSearchParams({ connection_id: connectionId, draft: draft ? "1" : "0" }),
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = (await response.json().catch(() => ({}))) as LaunchResponse;
  if (!(response.ok && body.href)) {
    throw new Error(body.message || `Could not start browser session (${response.status})`);
  }
  return body.href;
}

async function startBrowserRun(connectorId: string, connectionId: string, draft: boolean): Promise<string> {
  const alreadyStarted = await recoverStartedBrowserRun(connectorId, connectionId);
  if (alreadyStarted) {
    return alreadyStarted;
  }

  try {
    return await postStartBrowserRun(connectorId, connectionId, draft);
  } catch (err) {
    if (isLostTransportError(err)) {
      const recovered = await recoverStartedBrowserRun(connectorId, connectionId, 6);
      if (recovered) {
        return recovered;
      }
    }
    throw err;
  }
}

function launchErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "The browser session could not start.";
  return isLostTransportError(err)
    ? "DataConnect may have started the browser run, but this page could not confirm it after the network changed. Open Syncs, or try again if no new run appears."
    : message;
}

export function BrowserSessionLaunchPanel({
  connectionId,
  connectorId,
  displayName,
  draft,
  previewState,
  icon,
}: {
  connectionId: string;
  connectorId: string;
  displayName: string;
  draft: boolean;
  previewState?: string;
  icon?: ConnectorIconLike | null;
}) {
  const [state, setState] = useState<LaunchState>({ error: previewState && previewState !== "opening" ? (previewState === "busy" ? flowPreview.busyError : flowPreview.startError) : null, networkLost: previewState === "lost-contact", starting: !previewState || previewState === "opening" });
  const startedRef = useRef(false);

  function start() {
    if (previewState) return;
    setState({ error: null, networkLost: false, starting: true });
    startBrowserRun(connectorId, connectionId, draft)
      .then((href) => {
        window.location.assign(`${href}${href.includes("?") ? "&" : "?"}auto_open=1`);
      })
      .catch((err) => {
        setState({ error: launchErrorMessage(err), networkLost: isLostTransportError(err), starting: false });
      });
  }

  useEffect(() => {
    if (previewState || startedRef.current) {
      return;
    }
    startedRef.current = true;
    setState({ error: null, networkLost: false, starting: true });
    startBrowserRun(connectorId, connectionId, draft)
      .then((href) => {
        window.location.assign(`${href}${href.includes("?") ? "&" : "?"}auto_open=1`);
      })
      .catch((err) => {
        setState({ error: launchErrorMessage(err), networkLost: isLostTransportError(err), starting: false });
      });
  }, [connectionId, connectorId, draft, previewState]);

  return <LaunchPresentation connectorId={connectorId} displayName={displayName} icon={icon} onRetry={start} state={state} />;
}

export function LaunchPresentation({ connectorId, displayName, icon, onRetry, state }: { connectorId: string; displayName: string; icon?: ConnectorIconLike | null; onRetry: () => void; state: LaunchState }) {
  const title = state.starting ? `Opening ${displayName}…` : state.networkLost ? "This page lost contact with DataConnect." : `${displayName}'s sign-in page couldn't be opened.`;
  return <>
    <ConnectHeader connectorKey={connectorId} icon={icon} name={displayName} title={title} step="Step 1 of 2: sign in" />
    <section className="grid max-w-xl gap-4">
      {state.starting ? <p className="text-muted-foreground">This can take a minute. Keep this page open.</p> : null}
      {!state.starting && !state.networkLost && /busy|queued|deferred/i.test(state.error ?? "") ? <p className="text-muted-foreground">DataConnect is signing in to another service right now. Try again in a moment.</p> : null}
      {!state.starting ? <div className="flex flex-wrap gap-2"><button className={buttonVariants({ size: "sm", variant: "default" })} onClick={onRetry} type="button">{state.networkLost ? "Check again" : "Try again"}</button>{!state.networkLost ? <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources/add">Back to all services</Link> : null}</div> : null}
      {state.error && !state.networkLost ? <WentWrong message={state.error.replaceAll(/secure browser/giu, "browser")} /> : null}
    </section>
  </>;
}
