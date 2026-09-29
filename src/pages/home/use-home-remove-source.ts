// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  consoleDangerZonePath,
  serverRepairsHref,
} from "@/lib/platform/console-source-path"
import type { Platform } from "@/types"

/** Remove-source dialog state; confirming opens the console danger zone. */
export function useHomeRemoveSource() {
  const navigate = useNavigate()
  const [platform, setPlatform] = useState<Platform | null>(null)
  const cancel = useCallback(() => setPlatform(null), [])
  const confirm = useCallback(
    (target: Platform) => {
      setPlatform(null)
      navigate(serverRepairsHref(consoleDangerZonePath(target)))
    },
    [navigate]
  )
  return { platform, request: setPlatform, cancel, confirm }
}
