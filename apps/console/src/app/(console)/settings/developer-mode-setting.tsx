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
    <div className="grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3">
      <label className="flex items-start gap-2" htmlFor="developer-mode">
        <input
          checked={enabled}
          id="developer-mode"
          onChange={event => setDeveloperMode(event.currentTarget.checked)}
          type="checkbox"
        />
        <span className="grid gap-1">
          <span className="pdpp-caption font-medium text-foreground">
            Enable developer connector surfaces
          </span>
          <span className="pdpp-caption text-muted-foreground">
            This reveals local connector sources and the development connector
            filter on Add source. It is stored in this browser and is off by
            default.
          </span>
        </span>
      </label>
    </div>
  )
}
