"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react"
import {
  getDeveloperModeServerSnapshot,
  getDeveloperModeSnapshot,
  setDeveloperMode,
  subscribeToDeveloperMode,
} from "../lib/source-setup-development.ts"

export function DeveloperModeSetting() {
  const enabled = useSyncExternalStore(
    subscribeToDeveloperMode,
    getDeveloperModeSnapshot,
    getDeveloperModeServerSnapshot
  )

  return (
    <div className="border-y border-border/70 py-3">
      <label className="flex min-h-11 items-start gap-3" htmlFor="developer-mode">
        <input
          checked={enabled}
          id="developer-mode"
          onChange={event => setDeveloperMode(event.currentTarget.checked)}
          type="checkbox"
        />
        <span className="grid gap-1">
          <span className="text-[15px] font-medium text-foreground">
            Show data sources that are still being built
          </span>
          <span className="text-[13px] text-muted-foreground">
            This shows in-development data sources on Add a data source. It is stored
            in this browser and is off by default.
          </span>
        </span>
      </label>
    </div>
  )
}
