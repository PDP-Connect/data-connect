// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { invoke } from "@tauri-apps/api/core"
import {
  setConnectorUpdates,
  setIsCheckingUpdates,
  type AppDispatch,
} from "@/state/store"
import type { ConnectorUpdateInfo } from "@/types"

interface CheckConnectorUpdatesOptions {
  onError?: (error: unknown) => void
}

export async function checkConnectorUpdates(
  dispatch: AppDispatch,
  options: CheckConnectorUpdatesOptions = {}
) {
  const { onError } = options
  dispatch(setIsCheckingUpdates(true))
  try {
    const updates = await invoke<ConnectorUpdateInfo[]>("check_connector_updates")
    dispatch(setConnectorUpdates(updates))
    return updates
  } catch (error) {
    onError?.(error)
    return []
  } finally {
    dispatch(setIsCheckingUpdates(false))
  }
}
