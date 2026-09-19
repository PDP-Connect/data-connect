"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react"
import { exportRecoveryCodeAction } from "./recovery-key-actions.ts"

/**
 * Exports the desktop database encryption key as a printable recovery code
 * (src-tauri/src/recovery_code.rs). This is the ONLY durable copy of that
 * key an owner can access outside the OS keychain -- a lost keychain entry
 * with no recovery code on hand is permanent, total data loss of the
 * encrypted Personal Server vault.
 *
 * The warning copy below is deliberately about CUSTODY, not phishing: per
 * ai/research/product-design/local-vault-key-recovery-artifact-should-be-a-checksummed-code-not-a-raw-keyfile-or-bip39-mnemonic.md,
 * none of 1Password/Signal/Bitwarden/Proton/Apple/age treat phishing as the
 * primary risk for a recovery artifact like this one -- the risk is where
 * the physical/digital copy ends up, since it is never routinely typed into
 * any UI during normal use.
 */
export function RecoveryKeySetting({
  exportCode: suppliedExportCode,
}: {
  exportCode?: typeof exportRecoveryCodeAction
} = {}) {
  const exportCode = suppliedExportCode ?? exportRecoveryCodeAction
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  const runExport = () => {
    setBusy(true)
    setError(null)
    setCopyState("idle")
    void exportCode()
      .then(result => {
        if (!result.ok) {
          setError(result.message)
          return
        }
        setCode(result.code)
      })
      .catch(reason => setError(String(reason)))
      .finally(() => setBusy(false))
  }

  const copyCode = () => {
    if (!code || !navigator.clipboard?.writeText) {
      setCopyState("failed")
      return
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"))
  }

  return (
    <div className="grid gap-3">
      <p className="pdpp-caption text-muted-foreground">
        Anyone who has this code can read everything in your Personal Server vault. Store it somewhere only you control, such as a password manager or a safe.
      </p>

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {code ? (
        <div className="grid gap-2">
          <pre className="select-all overflow-x-auto rounded-md border border-border/70 bg-muted/10 px-3 py-2 font-mono text-sm text-foreground">
            {code}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="justify-self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={copyCode}
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
        onClick={runExport}
        type="button"
      >
        {busy ? "Exporting…" : code ? "Export again" : "Export recovery code"}
      </button>
    </div>
  )
}
