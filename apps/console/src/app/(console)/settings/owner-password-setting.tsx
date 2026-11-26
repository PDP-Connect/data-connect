"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button.tsx"
import { useRef, useState } from "react"
import { requestOwnerPasswordWindowAction } from "./owner-password-first-setup-actions.ts"
import {
  changeOwnerPasswordAction,
  requestDesktopOwnerPasswordChangeAction,
} from "./owner-password-actions.ts"
import { OwnerCredentialSetting } from "./owner-credential-setting.tsx"
import type { OwnerPasswordSource } from "./owner-password-data.ts"

/**
 * The one "Owner password" section. `source` comes from the RI
 * (`loadOwnerPasswordSource`). For "desktop", the DataConnect keychain holds
 * the password: reveal it for another device, or set a new one through the
 * native window. `canReveal` is true only in the desktop's own webview.
 */
export function OwnerPasswordSetting({
  canReveal = false,
  managedDesktop = false,
  passwordSet = true,
  source,
  practice = false,
}: {
  practice?: boolean
  canReveal?: boolean
  managedDesktop?: boolean
  /** False while the owner has not chosen a password yet (desktop only). */
  passwordSet?: boolean
  source: OwnerPasswordSource
}) {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Enter in a password field submits even while the button is disabled, and
  // two Enters in one tick both read busy as false. A ref closes both.
  const submitting = useRef(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    if (practice) { setMessage("This is a practice state. Your password is unchanged."); return }
    setMessage(null)
    if (Array.from(newPassword).length < 15) {
      setMessage("Use at least 15 characters for the new password.")
      return
    }
    if (newPassword !== confirmation) {
      setMessage("The new passwords do not match.")
      return
    }

    submitting.current = true
    setBusy(true)
    try {
      const result = await changeOwnerPasswordAction(
        currentPassword,
        newPassword
      )
      if (!result.ok) {
        setMessage("Could not change the password. Try again.")
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
        "Could not change the password. Try again."
      )
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function requestDesktopChange() {
    if (practice) { setMessage("This is a practice state. Your password is unchanged."); return }
    setMessage(null)
    setBusy(true)
    try {
      const result = passwordSet
        ? await requestDesktopOwnerPasswordChangeAction()
        : await requestOwnerPasswordWindowAction()
      if (!result.ok) {
        setMessage(
          "Could not open the password window. Try again."
        )
        return
      }
      setMessage("Password window opened.")
      router.refresh()
    } catch (error) {
      setMessage(
        "Could not open the password window. Try again."
      )
    } finally {
      setBusy(false)
    }
  }

  if (source === "env") {
    return <p className="pdpp-caption text-muted-foreground">This password is set where DataConnect was installed. Change it there, then restart DataConnect.</p>
  }

  if (source === "desktop" && !canReveal) {
    return <p className="pdpp-caption text-muted-foreground">Change or show the password in the DataConnect app on the computer that runs it.</p>
  }

  if (source === "desktop") {
    return (
      <div className="grid justify-items-start gap-3">
        <p className="pdpp-caption text-muted-foreground">
          {passwordSet ? "You chose this password." : "DataConnect made a password for you. You need it only to sign in from another device."}
        </p>
        {canReveal ? <OwnerCredentialSetting practice={practice} /> : null}
        {message ? (
          <p className="pdpp-caption text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}
        <Button
          className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void requestDesktopChange()}
          type="button"
        >
          {busy ? "Checking…" : passwordSet ? "Change password" : "Set password"}
        </Button>
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
      <Button
        className="justify-self-start rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-50"
        disabled={busy}
        type="submit"
      >
        {busy ? "Changing…" : "Change password"}
      </Button>
    </form>
  )
}
