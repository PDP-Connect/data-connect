"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  changeOwnerPasswordAction,
  requestDesktopOwnerPasswordChangeAction,
} from "./owner-password-actions.ts"
import type { OwnerPasswordSource } from "./owner-password-data.ts"

export function OwnerPasswordSetting({
  linuxLocalOnlyNoPromptNotice = null,
  source,
}: {
  linuxLocalOnlyNoPromptNotice?: string | null
  source: OwnerPasswordSource
}) {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    if (Array.from(newPassword).length < 15) {
      setMessage("Use at least 15 characters for the new password.")
      return
    }
    if (newPassword !== confirmation) {
      setMessage("The new passwords do not match.")
      return
    }

    setBusy(true)
    try {
      const result = await changeOwnerPasswordAction(
        currentPassword,
        newPassword
      )
      if (!result.ok) {
        setMessage(result.message ?? "Could not change the owner password.")
        return
      }
      setCurrentPassword("")
      setNewPassword("")
      setConfirmation("")
      setMessage(
        "Password changed. Other signed-in devices have been signed out."
      )
      router.refresh()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not change the owner password."
      )
    } finally {
      setBusy(false)
    }
  }

  async function requestDesktopChange() {
    setMessage(null)
    setBusy(true)
    try {
      const result = await requestDesktopOwnerPasswordChangeAction()
      if (!result.ok) {
        setMessage(
          result.message ?? "Could not open the desktop password window."
        )
        return
      }
      setMessage(
        result.linuxPolkitUnverified && !linuxLocalOnlyNoPromptNotice
          ? "Password window opened."
          : "Password window opened."
      )
      router.refresh()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not open the desktop password window."
      )
    } finally {
      setBusy(false)
    }
  }

  if (source === "env") {
    return (
      <div className="grid justify-items-start gap-2">
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm opacity-60"
          disabled
          type="button"
        >
          Change password
        </button>
        <p className="pdpp-caption text-muted-foreground">
          Password change is disabled because this install uses{" "}
          <code>PDPP_OWNER_PASSWORD</code>.
        </p>
        <p className="pdpp-caption text-muted-foreground">
          Change that environment variable, then restart the server. The
          environment value stays authoritative while it is set.
        </p>
      </div>
    )
  }

  if (source === "desktop") {
    return (
      <div className="grid justify-items-start gap-2">
        {message ? (
          <p className="pdpp-caption text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}
        <button
          className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
          disabled={busy || Boolean(linuxLocalOnlyNoPromptNotice)}
          onClick={() => void requestDesktopChange()}
          type="button"
        >
          {busy ? "Checking…" : "Change password"}
        </button>
        <p className="pdpp-caption text-muted-foreground">
          {linuxLocalOnlyNoPromptNotice
            ? "Password change is unavailable on Linux until OS re-auth is verified."
            : "DataConnect will ask this computer to confirm first, then open the local password window."}
        </p>
        {linuxLocalOnlyNoPromptNotice ? (
          <p className="pdpp-caption text-muted-foreground" role="status">
            {linuxLocalOnlyNoPromptNotice}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={event => void submit(event)}
    >
      <p className="pdpp-caption text-muted-foreground">
        Use at least 15 characters. Your current browser stays signed in; other
        sessions are ended.
      </p>
      {message ? (
        <p className="pdpp-caption text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      <label className="grid gap-1 text-sm">
        Current password
        <input
          autoComplete="current-password"
          className="rounded-md border border-border bg-background px-3 py-2"
          onChange={event => setCurrentPassword(event.target.value)}
          required
          type="password"
          value={currentPassword}
        />
      </label>
      <label className="grid gap-1 text-sm">
        New password
        <input
          autoComplete="new-password"
          className="rounded-md border border-border bg-background px-3 py-2"
          minLength={15}
          onChange={event => setNewPassword(event.target.value)}
          required
          type="password"
          value={newPassword}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Confirm new password
        <input
          autoComplete="new-password"
          className="rounded-md border border-border bg-background px-3 py-2"
          minLength={15}
          onChange={event => setConfirmation(event.target.value)}
          required
          type="password"
          value={confirmation}
        />
      </label>
      <button
        className="justify-self-start rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
        disabled={busy}
        type="submit"
      >
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  )
}
