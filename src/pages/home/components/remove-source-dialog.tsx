// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@/components/typography/text"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { Platform } from "@/types"
import type { RemoveSourceAction } from "../use-home-remove-source"

interface RemoveSourceDialogProps {
  platform: Platform | null
  canSignOut: boolean
  hasServerConnection: boolean
  pending: RemoveSourceAction | null
  error: string | null
  onCancel: () => void
  onSignOut: () => void
  onRemoveLocalData: () => void
  onOpenServerRepairs: () => void
}

/**
 * Offers the local removal choices for a home-screen source. The row comes
 * from data on this computer, so each choice changes only that data; server
 * copies stay in Server & Repairs.
 */
export function RemoveSourceDialog({
  platform,
  canSignOut,
  hasServerConnection,
  pending,
  error,
  onCancel,
  onSignOut,
  onRemoveLocalData,
  onOpenServerRepairs,
}: RemoveSourceDialogProps) {
  const name = platform?.name
  const isPdppSource = platform?.runtime === "pdpp-network"
  const busy = pending !== null

  return (
    <AlertDialog
      open={Boolean(platform)}
      onOpenChange={open => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent size="sm" className="max-w-[380px]!">
        <AlertDialogHeader>
          <AlertDialogTitle className="w-full text-left">
            Remove {name}
          </AlertDialogTitle>
          <AlertDialogDescription className="w-full text-left text-small">
            Choose what to remove from this computer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-4">
          {canSignOut ? (
            <div className="grid gap-2">
              <Text as="p" intent="small" muted>
                Sign out deletes the saved browser sessions for {name} on this
                computer. Your saved data stays, and {name} stays in this list.
              </Text>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onSignOut}
              >
                {pending === "sign-out" ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Text as="p" intent="small" muted>
              {canSignOut ? "Signs out, then deletes" : "Deletes"} the data this
              app saved for {name} on this computer
              {isPdppSource ? ", including its sync position" : ""}, and removes{" "}
              {name} from this list.
              {isPdppSource
                ? " The next import starts from the beginning."
                : ""}{" "}
              This cannot be undone.
            </Text>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onRemoveLocalData}
            >
              {pending === "remove"
                ? "Removing…"
                : "Remove and delete local data"}
            </Button>
          </div>
          {error ? (
            <Text as="p" intent="small" color="destructive" role="alert">
              {error}
            </Text>
          ) : null}
          <Text as="p" intent="small" muted>
            Copies already sent to your server do not change. Server copies, if
            any, are managed in Server & Repairs.
          </Text>
          {hasServerConnection ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={busy}
              onClick={onOpenServerRepairs}
            >
              Open Server & Repairs
            </Button>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" className="col-span-2" disabled={busy}>
            Cancel
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
