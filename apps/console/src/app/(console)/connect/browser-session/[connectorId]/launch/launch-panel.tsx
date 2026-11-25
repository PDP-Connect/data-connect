"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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
}: {
  connectionId: string;
  connectorId: string;
  displayName: string;
  draft: boolean;
}) {
  const [state, setState] = useState<LaunchState>({ error: null, networkLost: false, starting: true });
  const startedRef = useRef(false);

  function start() {
    setState({ error: null, networkLost: false, starting: true });
    startBrowserRun(connectorId, connectionId, draft)
      .then((href) => {
        window.location.assign(href);
      })
      .catch((err) => {
        setState({ error: launchErrorMessage(err), networkLost: isLostTransportError(err), starting: false });
      });
  }

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    setState({ error: null, networkLost: false, starting: true });
    startBrowserRun(connectorId, connectionId, draft)
      .then((href) => {
        window.location.assign(href);
      })
      .catch((err) => {
        setState({ error: launchErrorMessage(err), networkLost: isLostTransportError(err), starting: false });
      });
  }, [connectionId, connectorId, draft]);

  return (
    <section className="grid gap-4">
      <p className="pdpp-body text-muted-foreground">
        {state.starting ? (
          `DataConnect is opening the browser for ${displayName}. Keep this page open.`
        ) : state.networkLost ? (
          <>
            This page lost contact with DataConnect. Check <Link href="/syncs">sync history</Link> before trying again.
          </>
        ) : (
          "The browser could not open. Try again."
        )}
      </p>

      {state.error ? (
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonVariants({ className: "min-h-11", size: "sm", variant: "default" })}
            onClick={start}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      {state.error ? (
        <details className="pdpp-caption text-muted-foreground">
          <summary className="inline-flex min-h-11 cursor-pointer items-center">Details</summary>
          <p className="mt-2">{state.error.replaceAll(/PDPP/giu, "DataConnect")}</p>
          <Link className="mt-2 inline-flex min-h-11 items-center underline underline-offset-2" href="/syncs">
            Open sync history
          </Link>
          <Link
            className="mt-2 inline-flex min-h-11 items-center underline underline-offset-2"
            href={`/connect/browser-session/${encodeURIComponent(connectorId)}`}
          >
            Connect {displayName}
          </Link>
        </details>
      ) : null}
    </section>
  );
}
