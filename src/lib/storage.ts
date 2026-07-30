/** Centralized localStorage cleanup for removed app-level persistence. */

const STORAGE_VERSION = 'v1';

/**
 * Safe localStorage write that handles quota/blocked failures.
 * Returns true if write succeeded, false otherwise.
 */
function getStorage() {
  return typeof window !== "undefined" ? window.localStorage : null;
}

function safeRemoveItem(key: string): void {
  const storage = getStorage();
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    storage.removeItem(key);
  } catch {}
}

const PENDING_APPROVAL_KEY = `${STORAGE_VERSION}_pending_approval`;

export function clearLegacyPendingApproval(): void {
  safeRemoveItem(PENDING_APPROVAL_KEY);
}
