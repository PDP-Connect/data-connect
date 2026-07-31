/** Centralized localStorage cleanup for removed app-level persistence. */

const STORAGE_VERSION = "v1"

/**
 * Safe localStorage write that handles quota/blocked failures.
 * Returns true if write succeeded, false otherwise.
 */
function getStorage() {
  return typeof window !== "undefined" ? window.localStorage : null
}

function safeRemoveItem(key: string): void {
  const storage = getStorage()
  if (!storage || typeof storage.removeItem !== "function") return
  try {
    storage.removeItem(key)
  } catch {}
}

const PENDING_APPROVAL_KEY = `${STORAGE_VERSION}_pending_approval`
const PDPP_GRANT_COMPENSATION_KEY = `${STORAGE_VERSION}_pdpp_grant_compensation`

export type PendingPdppGrantCompensation = {
  sessionId: string
  grantId: string
  userAddress: string
}

export function clearLegacyPendingApproval(): void {
  safeRemoveItem(PENDING_APPROVAL_KEY)
}

/**
 * Records only the identifiers needed to retry revocation after PDPP handoff
 * creation fails. In particular, this must never contain a relay secret or a
 * PDPP bearer credential.
 */
export function savePendingPdppGrantCompensation(
  pending: PendingPdppGrantCompensation
): boolean {
  const storage = getStorage()
  if (!storage || typeof storage.setItem !== "function") return false
  try {
    const existing = getPendingPdppGrantCompensations()
    const withoutCurrent = existing.filter(
      candidate =>
        candidate.sessionId !== pending.sessionId ||
        candidate.grantId !== pending.grantId
    )
    storage.setItem(
      PDPP_GRANT_COMPENSATION_KEY,
      JSON.stringify([...withoutCurrent, pending])
    )
    return true
  } catch {
    return false
  }
}

export function getPendingPdppGrantCompensations(): PendingPdppGrantCompensation[] {
  const storage = getStorage()
  if (!storage || typeof storage.getItem !== "function") return []
  try {
    const value = storage.getItem(PDPP_GRANT_COMPENSATION_KEY)
    if (!value) return []
    const pending = JSON.parse(value)
    return Array.isArray(pending)
      ? pending.filter(
          candidate =>
            typeof candidate?.sessionId === "string" &&
            typeof candidate?.grantId === "string" &&
            typeof candidate?.userAddress === "string"
        )
      : []
  } catch {
    return []
  }
}

export function clearPendingPdppGrantCompensation(
  pending?: Pick<PendingPdppGrantCompensation, "sessionId" | "grantId">
): void {
  if (!pending) {
    safeRemoveItem(PDPP_GRANT_COMPENSATION_KEY)
    return
  }
  const storage = getStorage()
  if (!storage || typeof storage.setItem !== "function") return
  try {
    const remaining = getPendingPdppGrantCompensations().filter(
      candidate =>
        candidate.sessionId !== pending.sessionId ||
        candidate.grantId !== pending.grantId
    )
    if (remaining.length === 0) {
      storage.removeItem(PDPP_GRANT_COMPENSATION_KEY)
    } else {
      storage.setItem(PDPP_GRANT_COMPENSATION_KEY, JSON.stringify(remaining))
    }
  } catch {}
}
