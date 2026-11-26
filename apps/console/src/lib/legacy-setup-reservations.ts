// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One-time migration. Older consoles kept provider setups in browser storage.
// The host now holds them, so each saved setup and draft is offered to the host
// and checkpointed only after a settled Host outcome. Delete this file when no
// old console remains in use.
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

type LegacyRow = { raw: string; value: unknown }

function isLegacy(item: unknown): item is Legacy {
  return !!item && typeof item === "object" &&
    fields.every(key => {
      const value = (item as Record<string, unknown>)[key]
      return typeof value === "string" && value.length > 0
    })
}

function readLegacy(raw: string | null): LegacyRow[] | null {
  if (raw === null) return []
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(values)) return null
  if (!values.length) return []

  // JSON.parse validates syntax. Isolate each top-level token without writing
  // it back through JSON.stringify, which could alter an unsupported value.
  const rows: LegacyRow[] = []
  let start = raw.indexOf("[") + 1
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === "[" || c === "{") depth++
    else if (depth === 0 && (c === "," || c === "]")) {
      rows.push({ raw: raw.slice(start, i).trim(), value: values[rows.length] })
      start = i + 1
      if (c === "]") break
    } else if (c === "}" || c === "]") depth--
  }
  return rows
}

function checkpoint(storage: Store, original: LegacyRow) {
  // Merge against the latest snapshot after the request. This is best effort
  // and does not make localStorage an atomic cross-tab compare-and-set.
  const live = readLegacy(storage.getItem(setupKey))
  const index = live?.findIndex(row => row.raw === original.raw) ?? -1
  if (!live || index < 0) return
  live.splice(index, 1)
  if (live.length) storage.setItem(setupKey, "[" + live.map(row => row.raw).join(",") + "]")
  else storage.removeItem(setupKey)
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">

type LegacyDraft = { providerId: string; draftId: string; usage: string | null }

function readLegacyDraft(raw: string): LegacyDraft | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (
      !value ||
      typeof value.providerId !== "string" ||
      !value.providerId ||
      typeof value.draftId !== "string" ||
      !value.draftId
    ) {
      return null
    }
    return {
      providerId: value.providerId,
      draftId: value.draftId,
      usage: typeof value.usage === "string" && value.usage ? value.usage : null,
    }
  } catch {
    return null
  }
}

export async function migrateLegacySetupReservations(
  request: Request,
  stores: { local: Store; session: Store } | null = browserStorage()
): Promise<{ adopted: number; dropped: number; deferred: number; cleanup: number; draft: "none" | "sent" | "deferred" }> {
  const result = { adopted: 0, dropped: 0, deferred: 0, cleanup: 0, draft: "none" as "none" | "sent" | "deferred" }
  if (!stores) return result
  const storage = stores.local
  const rows = readLegacy(storage.getItem(setupKey))
  if (rows === null) result.deferred++
  for (const row of rows ?? []) {
    const reservation = row.value
    if (!isLegacy(reservation)) {
      result.deferred++
      continue
    }
    const answer = await request("/setups/adopt", Object.fromEntries(fields.map(key => [key, reservation[key]])))
    const data = answer.ok ? adoption(answer.data) : null
    if (data?.adopted === true) result.adopted++
    else if (data?.adopted === false && data.reason === "needs_cleanup") result.cleanup++
    else if (data?.adopted === false && (data.reason === "unknown" || data.reason === "ended" || data.reason === "cancelled")) result.dropped++
    else {
      result.deferred++
      continue
    }
    checkpoint(storage, row)
  }

  const rawDraft = stores.session.getItem(draftKey)
  if (rawDraft === null) return result
  const draft = readLegacyDraft(rawDraft)
  result.draft = "deferred"
  if (!draft) return result
  const answer = await request("/setups/adopt-draft", { ...draft })
  const data = answer.ok ? adoption(answer.data) : null
  if (data?.adopted === true ||
      (data?.adopted === false && (data.reason === "unknown" || data.reason === "service_has_draft"))) {
    if (stores.session.getItem(draftKey) === rawDraft) stores.session.removeItem(draftKey)
    result.draft = "sent"
  }
  return result
}

function adoption(value: unknown): { adopted?: unknown; reason?: unknown } | null {
  return value !== null && typeof value === "object" ? value as { adopted?: unknown; reason?: unknown } : null
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
