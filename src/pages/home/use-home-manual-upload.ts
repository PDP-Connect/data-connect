// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { Platform } from "@/types"

export function useHomeManualUpload(
  onImportReady: (platform: Platform, importDirectory: string) => void
) {
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [isPreparing, setIsPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    if (isPreparing) return
    setPlatform(null)
    setError(null)
  }, [isPreparing])

  const open = useCallback((nextPlatform: Platform) => {
    setPlatform(nextPlatform)
    setError(null)
  }, [])

  const chooseImport = useCallback(
    async (directory: boolean) => {
      if (!platform || isPreparing) return

      setIsPreparing(true)
      setError(null)
      try {
        const importDirectory = await invoke<string | null>(
          "prepare_installed_pdpp_import",
          {
            connectorId: platform.id,
            directory,
          }
        )
        if (importDirectory === null) {
          setPlatform(null)
          return
        }

        setPlatform(null)
        onImportReady(platform, importDirectory)
      } catch (reason) {
        console.error("Failed to prepare import:", reason)
        setError("Could not prepare that export. Try again.")
      } finally {
        setIsPreparing(false)
      }
    },
    [isPreparing, onImportReady, platform]
  )

  return {
    platform,
    isPreparing,
    error,
    open,
    close,
    chooseImport,
  }
}
