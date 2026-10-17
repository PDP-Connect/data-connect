// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react"
import { type ConsolePortStatus, validatePinnedConsolePort } from "./remote-access.ts"

/**
 * The console's loopback address, whether it survives a restart, and the
 * owner's pin -- the same control for every provider. It renders from
 * `consolePortStatus` alone, never from the provider id: a Cloudflare
 * dashboard route, an owner's proxy and an ngrok tunnel all target this
 * same address, and a pin is harmless where the app sets the route itself.
 */
export function ConsolePortSetting({
  busy,
  onPin,
  pinnedPort,
  status,
}: {
  busy: boolean
  /** Resolves to an error message, or `null` on success. */
  onPin: (port: number | null) => Promise<string | null>
  pinnedPort: number | null
  status: ConsolePortStatus
}) {
  const address = `http://127.0.0.1:${status.port}`
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const [draft, setDraft] = useState(pinnedPort != null ? String(pinnedPort) : String(status.port))
  const [error, setError] = useState<string | null>(null)

  const copyAddress = () => {
    if (!navigator.clipboard?.writeText) {
      setCopyState("failed")
      return
    }
    void navigator.clipboard
      .writeText(address)
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"))
  }

  const pin = (port: number | null) => {
    setError(null)
    void onPin(port).then(setError)
  }

  const savePin = () => {
    const validation = validatePinnedConsolePort(draft)
    if (!validation.ok) {
      setError(validation.message)
      return
    }
    if (validation.port == null) {
      setError("Enter a port to pin, or choose Unpin.")
      return
    }
    pin(validation.port)
  }

  const draftPort = Number.parseInt(draft.trim(), 10)
  const draftMovesConsole = Number.isInteger(draftPort) && draftPort !== status.port

  return (
    <div className="grid gap-1">
      <p className="pdpp-caption text-foreground">Console address on this computer</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="select-all font-mono text-xs text-foreground/80">{address}</span>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={copyAddress}
          type="button"
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </button>
        {copyState === "failed" ? (
          <span className="pdpp-caption text-muted-foreground">
            Could not copy automatically. Select the address and copy it manually.
          </span>
        ) : null}
      </div>
      {status.kind === "moved" ? (
        <p className="pdpp-caption text-destructive" role="alert">
          Port {status.stablePort} was in use when DataConnect started, so the console is on port{" "}
          {status.port} for now. A tunnel route or proxy that points at port {status.stablePort}{" "}
          does not reach DataConnect. Free port {status.stablePort} and restart DataConnect, or
          point the route at port {status.port} and pin it below.
        </p>
      ) : status.kind === "pinned" ? (
        <p className="pdpp-caption text-muted-foreground">
          Pinned. DataConnect always uses this port, and does not start if another program has
          taken it.
        </p>
      ) : status.kind === "kept" ? (
        <p className="pdpp-caption text-muted-foreground">
          DataConnect keeps this port across restarts and updates. If another program takes it,
          DataConnect starts on a different port and tells you here.
        </p>
      ) : (
        <p className="pdpp-caption text-muted-foreground">
          This server's environment sets this port (PORT).
        </p>
      )}
      {status.kind === "environment" ? null : (
        <div className="grid gap-1">
          <label className="grid gap-1 pdpp-caption text-foreground" htmlFor="remote-access-console-port">
            Pin a port
            <input
              autoComplete="off"
              className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              id="remote-access-console-port"
              inputMode="numeric"
              onChange={event => setDraft(event.currentTarget.value)}
              type="text"
              value={draft}
            />
          </label>
          <span className="pdpp-caption text-muted-foreground">
            To keep an existing route working, enter the port it already points at.
            {draftMovesConsole
              ? ` DataConnect restarts on port ${draftPort}; until the route points there, it does not reach DataConnect.`
              : ""}
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              disabled={busy}
              onClick={savePin}
              type="button"
            >
              Pin
            </button>
            {pinnedPort != null ? (
              <button
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={() => pin(null)}
                type="button"
              >
                Unpin
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="pdpp-caption text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
