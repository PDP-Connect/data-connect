// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One-time migration. Older consoles kept provider setups in browser storage.
// The host now holds them, so each saved setup is offered to the host once and
// the browser copy is then removed. Delete this file when no old console
// remains in use.
type Request = (
  path: string,
  body?: Record<string, unknown>
) => Promise<{ ok: true; data: unknown } | { ok: false; message: string; code: string }>

const setupKey = "reachability-setup-reservations-v1"
const draftKey = "reachability-draft"
const fields = [
  "operationId",
  "providerId",
  "providerLabel",
  "draftId",
  "actionId",
  "expectedConfigurationRevision",
  "usage",
] as const

type Legacy = Record<(typeof fields)[number], string>

function readLegacy(storage: Pick<Storage, "getItem">): Legacy[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(setupKey) ?? "[]")
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is Legacy =>
        !!item &&
        typeof item === "object" &&
        fields.every(key => typeof item[key] === "string" && item[key].length > 0)
    )
  } catch {
    return []
  }
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">

export async function migrateLegacySetupReservations(
  request: Request,
  stores: { local: Store; session: Store } | null = browserStorage()
): Promise<{ adopted: number; dropped: number; deferred: number }> {
  const result = { adopted: 0, dropped: 0, deferred: 0 }
  if (!stores) return result
  const storage = stores.local
  const pending: Legacy[] = []
  for (const reservation of readLegacy(storage)) {
    const answer = await request("/setups/adopt", { ...reservation })
    if (!answer.ok) {
      // The host did not answer. Keep the saved copy and try again next time.
      pending.push(reservation)
      result.deferred++
    } else if ((answer.data as { adopted?: boolean }).adopted) {
      result.adopted++
    } else {
      result.dropped++
    }
  }
  if (pending.length) storage.setItem(setupKey, JSON.stringify(pending))
  else storage.removeItem(setupKey)
  // The draft pointer only named a draft the host already holds.
  stores.session.removeItem(draftKey)
  return result
}

function browserStorage() {
  try {
    return globalThis.localStorage && globalThis.sessionStorage
      ? { local: globalThis.localStorage, session: globalThis.sessionStorage }
      : null
  } catch {
    return null
  }
}
