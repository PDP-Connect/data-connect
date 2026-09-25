"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react"
import { revealOwnerCredentialAction } from "./owner-credential-actions.ts"

/**
 * Reveals the owner's own auto-generated login password
 * (src-tauri/src/owner_credential.rs) so it can be typed into a second
 * device's `/owner/login` page. Unlike the recovery key below, this is the
 * LIVE login credential, not an offline backup: it is typed on other
 * devices routinely, not transcribed once during an incident, so the
 * warning copy is framed around who can see the screen right now, not
 * where a written-down copy might end up.
 *
 * See ai/research/product-design/auto-generated-owner-credentials-need-an-explicit-reveal-moment-not-just-mint-and-verify.md:
 * before this route existed, there was no way for the owner to learn this
 * password at all -- the desktop app logs itself in silently on the machine
 * that generated it, and this was the one and only place a human is ever
 * asked to type it.
 */
export function OwnerCredentialSetting({
  linuxLocalOnlyNoPromptNotice = null,
  reveal: suppliedReveal,
}: {
  linuxLocalOnlyNoPromptNotice?: string | null
  reveal?: typeof revealOwnerCredentialAction
} = {}) {
  const reveal = suppliedReveal ?? revealOwnerCredentialAction
  const [password, setPassword] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linuxPolkitUnverified, setLinuxPolkitUnverified] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  const runReveal = () => {
    setBusy(true)
    setError(null)
    setLinuxPolkitUnverified(false)
    setCopyState("idle")
    void reveal()
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setLinuxPolkitUnverified(Boolean(result.linuxPolkitUnverified))
        setPassword(result.password)
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusy(false))
  }

  const copyPassword = () => {
    if (!password || !navigator.clipboard?.writeText) {
      setCopyState("failed")
      return
    }
    void navigator.clipboard
      .writeText(password)
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"))
  }

  return (
    <div className="grid gap-3">
      <p className="pdpp-caption text-muted-foreground">
        This is the password you type to sign in from another device, such as a phone reaching this Personal Server over its remote-access URL. Make sure no one else can see your screen before revealing it.
      </p>
      {linuxLocalOnlyNoPromptNotice ? (
        <p className="pdpp-caption text-muted-foreground" role="status">
          {linuxLocalOnlyNoPromptNotice}
        </p>
      ) : null}

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {password ? (
        <div className="grid gap-2">
          {linuxPolkitUnverified && !linuxLocalOnlyNoPromptNotice ? (
            <p className="pdpp-caption text-muted-foreground" role="status">
              This Linux build allows local-only reveal without an OS prompt until polkit is verified.
            </p>
          ) : null}
          <pre className="select-all overflow-x-auto rounded-md border border-border/70 bg-muted/10 px-3 py-2 font-mono text-sm text-foreground">
            {password}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="justify-self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={copyPassword}
              type="button"
            >
              {copyState === "copied" ? "Copied" : "Copy to clipboard"}
            </button>
            {copyState === "failed" ? (
              <span className="pdpp-caption text-muted-foreground">
                Could not copy automatically. Select the text above and copy it manually.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        className="justify-self-start rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
        disabled={busy}
        onClick={runReveal}
        type="button"
      >
        {busy ? "Revealing…" : password ? "Reveal again" : "Reveal password"}
      </button>
    </div>
  )
}
