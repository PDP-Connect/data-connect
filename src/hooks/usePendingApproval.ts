import { useEffect } from "react"
import { clearLegacyPendingApproval } from "../lib/storage"

/** Removes insecure legacy relay-secret recovery data on startup. */
export function useClearLegacyPendingApproval() {
  useEffect(() => {
    clearLegacyPendingApproval()
  }, [])
}
