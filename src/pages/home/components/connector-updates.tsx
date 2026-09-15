// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { RefreshCw as RefreshCwIcon } from "lucide-react"

import { stateFocus } from "@/components/typography/field"
import { Text } from "@/components/typography/text"
import { cn } from "@/lib/utils"

const refreshButtonClassName = cn([
  // layout
  "inline-flex items-center gap-1",
  // spacing
  "px-2 py-1",
  // shape
  "rounded-md",
  // colors
  "text-muted-foreground",
  // focus
  stateFocus,
  // disabled
  "disabled:pointer-events-none disabled:opacity-50",
  // transitions
  "transition-colors",
  // states
  "hover:bg-muted hover:text-foreground",
])

interface ConnectorUpdatesRefreshButtonProps {
  isCheckingUpdates: boolean
  onRefresh: () => void | Promise<void>
}

/** The update control belongs beside the Import sources heading. */
export function ConnectorUpdatesRefreshButton({
  isCheckingUpdates,
  onRefresh,
}: ConnectorUpdatesRefreshButtonProps) {
  return (
    <button
      type="button"
      onClick={() => void onRefresh()}
      disabled={isCheckingUpdates}
      className={refreshButtonClassName}
    >
      <RefreshCwIcon
        className={cn(
          "size-3",
          isCheckingUpdates && "animate-spin motion-reduce:animate-none"
        )}
        aria-hidden
      />
      <Text as="span" intent="small" color="inherit">
        Refresh
      </Text>
    </button>
  )
}
