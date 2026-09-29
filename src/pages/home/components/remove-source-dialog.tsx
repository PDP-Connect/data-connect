// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@/components/typography/text"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { Platform } from "@/types"

interface RemoveSourceDialogProps {
  platform: Platform | null
  onCancel: () => void
  onConfirm: (platform: Platform) => void
}

/**
 * Explains the two ways to remove a source, then hands off to the console
 * danger zone, which owns the confirmed Revoke and Delete controls.
 */
export function RemoveSourceDialog({
  platform,
  onCancel,
  onConfirm,
}: RemoveSourceDialogProps) {
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
            Remove {platform?.name}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-left">
            You can revoke or delete this source in Server & Repairs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2">
          <Text as="p" intent="small" muted>
            Revoke stops future collection and signs out the saved browser
            session. Your records are kept.
          </Text>
          <Text as="p" intent="small" muted>
            Delete permanently erases this source’s records, its sync position
            and the saved browser session. This cannot be undone.
          </Text>
          <Text as="p" intent="small" muted>
            Apps you granted access stay authorized. They stop receiving this
            source’s data and keep any copies they already received.
          </Text>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            onClick={() => {
              if (platform) onConfirm(platform)
            }}
          >
            Open Server & Repairs
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
