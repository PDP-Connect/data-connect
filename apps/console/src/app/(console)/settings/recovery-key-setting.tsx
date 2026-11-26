"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/components/ui/button.tsx"
import { Diagnostics } from "./diagnostics.tsx"
import { useEffect, useRef, useState } from "react"
import { exportRecoveryKitAction } from "./recovery-key-actions.ts"

/**
 * Exports the Personal Server recovery kit as a printable code. The kit holds
 * encryption keys only: the credential-vault key, plus the SQLite database key
 * when this server uses an encrypted SQLite vault. It does not back up the
 * database file or a Postgres database.
 *
 * The warning copy below is deliberately about CUSTODY, not phishing: per
 * ai/research/product-design/local-vault-key-recovery-artifact-should-be-a-checksummed-code-not-a-raw-keyfile-or-bip39-mnemonic.md,
 * none of 1Password/Signal/Bitwarden/Proton/Apple/age treat phishing as the
 * primary risk for a recovery artifact like this one -- the risk is where
 * the physical/digital copy ends up, since it is never routinely typed into
 * any UI during normal use.
 */
type Notice = "wrong" | "not-set" | "too-many" | "failed"

const NOTICE_WORDS: Record<Exclude<Notice, "failed">, string> = {
  "not-set": "Choose a password first.",
  "too-many": "Too many tries. Wait a little, then try again.",
  wrong: "That password isn't right.",
}

/** Fixed inputs for the development-only practice states (`?demo=recovery-*`). */
export type RecoveryPracticeState = "asking" | "wrong" | "no-password" | "shown"

const PRACTICE_CODE = "0200-0000-036B-6579-E5EA"

export function RecoveryKeySetting({
  exportKit: suppliedExportKit,
  passwordSource,
  practice = false,
  practiceState,
}: {
  exportKit?: typeof exportRecoveryKitAction
  /** "desktop" means DataConnect made the password, so the owner may not know it. */
  passwordSource?: "app" | "env" | "desktop" | null
  practice?: boolean
  practiceState?: RecoveryPracticeState
} = {}) {
  const exportKit = suppliedExportKit ?? exportRecoveryKitAction
  const [code, setCode] = useState<string | null>(practiceState === "shown" ? PRACTICE_CODE : null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(
    practiceState === "wrong" ? "wrong" : practiceState === "no-password" ? "not-set" : null
  )
  const [view, setView] = useState<"hidden" | "asking" | "revealed">(
    practiceState === "shown" ? "revealed" : practiceState !== undefined ? "asking" : "hidden"
  )
  const attempt = useRef(0)
  useEffect(() => () => { attempt.current += 1 }, [])
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  const cancel = () => {
    attempt.current += 1
    setView("hidden")
    setCode(null)
    setCopyState("idle")
    setBusy(false)
    setPassword("")
    setNotice(null)
    setError(null)
  }

  const runExport = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // The typed password lives only in this local for the one call; the field
    // is cleared before the request starts, so it is never in state afterwards.
    const typed = password
    setPassword("")
    if (practice) {
      setNotice(null)
      setError("This is a practice state. Your recovery code is unchanged.")
      return
    }
    const ticket = ++attempt.current
    setBusy(true)
    setError(null)
    setNotice(null)
    setCopyState("idle")
    void exportKit(typed)
      .then(result => {
        if (ticket !== attempt.current) return
        if (!result.ok) {
          if (result.reason === "failed") setError(result.message)
          else setNotice(result.reason)
          return
        }
        setCode(result.code)
        setView("revealed")
      })
      .catch(reason => { if (ticket === attempt.current) setError(String(reason)) })
      .finally(() => { if (ticket === attempt.current) setBusy(false) })
  }

  const copyCode = () => {
    if (!code || !navigator.clipboard?.writeText) {
      setCopyState("failed")
      return
    }
    const ticket = attempt.current
    void navigator.clipboard
      .writeText(code)
      .then(() => { if (ticket === attempt.current) setCopyState("copied") })
      .catch(() => { if (ticket === attempt.current) setCopyState("failed") })
  }

  return (
    <div className="grid gap-3">
      <p className="pdpp-caption text-muted-foreground">
        DataConnect locks your saved sign-ins with a key that this computer keeps. If the computer ever loses that key, this code unlocks them again. If your DataConnect database is encrypted, it also restores the key that unlocks your data. Keep it somewhere safe, such as a password manager. It does not hold your data: keep a backup of your DataConnect files as well. Anyone who has both can read everything.
      </p>

      {notice ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {NOTICE_WORDS[notice === "failed" ? "wrong" : notice]}
          {notice === "not-set" ? (
            <>
              {" "}
              <a className="underline" href="/settings/sign-in">Password and sign-in</a>
            </>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <>
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          Could not show the recovery code. Try again.
        </p>
        <Diagnostics><pre>{error}</pre></Diagnostics></>
      ) : null}

      {view === "revealed" && code ? (
        <div className="grid gap-2">
          <pre className="select-all break-all rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-[15px] text-foreground">
            {code}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-11 justify-self-start rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={copyCode}
              type="button"
            >
              {copyState === "copied" ? "Copied" : "Copy"}
            </Button>
            <Button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px]" onClick={cancel} type="button">
              Done
            </Button>
            {copyState === "failed" ? (
              <span className="pdpp-caption text-muted-foreground">
                Could not copy automatically. Select the code above and copy it manually.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {view === "asking" ? (
        <form className="grid max-w-xl gap-3" onSubmit={runExport}>
          <label className="grid gap-1 text-sm">
            Enter your password to show your recovery code
            <input
              autoComplete="current-password"
              className="rounded-md border border-border bg-background px-3 py-2"
              onChange={event => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {passwordSource === "desktop" ? (
            <p className="pdpp-caption text-muted-foreground">
              You can see your password under <a className="underline" href="/settings/sign-in">Password and sign-in</a>.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? "Checking…" : "Show recovery code"}
            </Button>
            <Button
              className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={busy}
              onClick={cancel}
              type="button"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : view === "hidden" ? (
        <Button
          className="min-h-11 justify-self-start rounded-[6px] border border-border px-3 text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          onClick={() => {
            setCode(null)
            setView("asking")
          }}
          type="button"
        >
          Show recovery code
        </Button>
      ) : null}
    </div>
  )
}
