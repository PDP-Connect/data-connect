// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react"

const key = "dataconnect_show_development_connectors"

export function useShowDevelopmentConnectors() {
  const [showDevelopmentConnectors, setShowDevelopmentConnectors] = useState(
    () => {
      try {
        return window.localStorage.getItem(key) === "true"
      } catch {
        return false
      }
    }
  )
  const updateShowDevelopmentConnectors = (value: boolean) => {
    try {
      if (value) window.localStorage.setItem(key, "true")
      else window.localStorage.removeItem(key)
    } catch {
      // Keep this session usable when storage is unavailable.
    }
    setShowDevelopmentConnectors(value)
  }
  return { showDevelopmentConnectors, updateShowDevelopmentConnectors }
}
