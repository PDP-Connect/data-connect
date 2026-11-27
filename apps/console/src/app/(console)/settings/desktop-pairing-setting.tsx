"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react"
import { createDesktopPairingAction } from "./desktop-pairing-actions.ts"
import { countdownLabel, secondsRemaining } from "./desktop-pairing.ts"

interface IssuedPairing {
  code: string
  link: string
  serverOrigin: string
  serverFingerprint: string
  /** Browser-clock deadline, from the server's lifetime at receipt. */
  deadlineMs: number
}

/**
 * What the owner sees for one issued code. At zero seconds left the code and
 * link are not rendered at all: an expired secret should not sit on screen.
 */
export function DesktopPairingDisplay({
  code,
  link,
  remainingSeconds,
  serverFingerprint,
  serverOrigin,
}: {
  code: string
  link: string
  remainingSeconds: number
  serverFingerprint: string
  serverOrigin: string
}) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const expired = remainingSeconds <= 0

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopyMessage(`${what} copied.`)
    } catch {
      setCopyMessage(
        `Could not copy. Select the ${what.toLowerCase()} and copy it by hand.`
      )
    }
  }

  return (
    <div className="grid gap-3">
      <p
        className={
          expired
            ? "text-sm text-destructive"
            : "pdpp-caption text-muted-foreground"
        }
        role="status"
      >
        {countdownLabel(remainingSeconds)}
      </p>
      {expired ? null : (
        <>
          <div className="flex max-w-xl flex-wrap items-center gap-2">
            <input
              aria-label="Server address"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              onFocus={event => event.currentTarget.select()}
              readOnly
              value={serverOrigin}
            />
            <button
              aria-label="Copy server address"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => void copy(serverOrigin, "Address")}
              type="button"
            >
              Copy
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="w-fit rounded-md border border-border/70 bg-muted px-3 py-2 font-mono text-lg tracking-widest text-foreground">
              {code}
            </p>
            <button
              aria-label="Copy pairing code"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => void copy(code, "Code")}
              type="button"
            >
              Copy
            </button>
          </div>
          <p className="pdpp-caption text-muted-foreground">
            Server ID{" "}
            <span className="font-mono text-foreground">
              {serverFingerprint}
            </span>
            . The desktop app shows the same ID when it connects.
          </p>
          <div className="flex max-w-xl flex-wrap items-center gap-2">
            <input
              aria-label="Pairing link"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              onFocus={event => event.currentTarget.select()}
              readOnly
              value={link}
            />
            <button
              aria-label="Copy pairing link"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => void copy(link, "Link")}
              type="button"
            >
              Copy
            </button>
          </div>
          {copyMessage ? (
            <p className="pdpp-caption text-muted-foreground" role="status">
              {copyMessage}
            </p>
          ) : null}
          <p className="text-sm text-foreground">
            In the DataConnect desktop app choose Connect to a server, then
            paste the link (or the address and the code).
          </p>
        </>
      )}
    </div>
  )
}

/**
 * The "Attach a desktop app" section. The server mints the code; this holds
 * it in memory only for as long as it is valid.
 */
export function DesktopPairingSetting() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState<IssuedPairing | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const deadlineMs = pairing?.deadlineMs ?? null
  const remaining =
    pairing && deadlineMs !== null ? secondsRemaining(deadlineMs, now) : 0

  useEffect(() => {
    if (deadlineMs === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadlineMs])

  // Drop the secret from memory once it has expired; the panel keeps showing
  // the "Expired" line.
  useEffect(() => {
    if (pairing?.code && remaining <= 0) {
      setPairing({ ...pairing, code: "", link: "" })
    }
  }, [pairing, remaining])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const result = await createDesktopPairingAction()
      if (!result.ok) {
        setError(result.message)
        return
      }
      const receivedAt = Date.now()
      setNow(receivedAt)
      setPairing({
        code: result.code,
        deadlineMs: receivedAt + result.expiresInSeconds * 1000,
        link: result.link,
        serverFingerprint: result.serverFingerprint,
        serverOrigin: result.serverOrigin,
      })
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create a pairing code."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4">
      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div>
        <button
          className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void create()}
          type="button"
        >
          {busy ? "Creating…" : "Create pairing code"}
        </button>
      </div>
      {pairing ? (
        <DesktopPairingDisplay
          code={pairing.code}
          link={pairing.link}
          remainingSeconds={remaining}
          serverFingerprint={pairing.serverFingerprint}
          serverOrigin={pairing.serverOrigin}
        />
      ) : null}
      <p className="pdpp-caption text-muted-foreground">
        A code works once and expires in 10 minutes. Paired computers appear
        under Owner sessions and can be signed out there.
      </p>
    </div>
  )
}
