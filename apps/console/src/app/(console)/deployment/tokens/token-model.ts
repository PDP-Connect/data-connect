// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { OwnerBearerView } from "../../settings/owner-sessions-data.ts"
import type {
  OwnerIssuedClient,
  OwnerClientToken,
} from "../../lib/ref-client.ts"
export interface TokenRemoval {
  id: string
  createdAt: string
  clientId?: string
}
export interface TokenGroup {
  key: string
  name: string
  createdAt: string
  clientId?: string
  tokens: TokenRemoval[]
  count: number
  incomplete?: boolean
}
const TECHNICAL_SCRIPT_NAME = /\b(?:exporter|heartbeat|stale|bearer|enrollment|revoked|VAPID|jitter|PDPP|Personal Server|keychain|connector|readiness|deployment|origin)\b|PDPP_[A-Z_]+|^https?:\/\/|^(?:cli|dcr|client)[_-]|^[a-z0-9_-]{24,}$/i;
function scriptName(value: string | null): string {
  const name = value?.trim();
  return !name || TECHNICAL_SCRIPT_NAME.test(name) ? "Script or tool" : name;
}
export function tokenGroups(
  clients: OwnerIssuedClient[],
  details: Record<string, OwnerClientToken[]>,
  owners: OwnerBearerView[]
): TokenGroup[] {
  const covered = new Set<string>()
  const groups: TokenGroup[] = clients.filter(client => client.client_id !== "dataconnect-console").map(client => {
    const tokens = (details[client.client_id] ?? []).map(token => {
      covered.add(token.token_id_public)
      return {
        id: token.token_id_public,
        createdAt: token.created_at,
        clientId: client.client_id,
      }
    })
    return {
      key: client.client_id,
      name: scriptName(client.client_name),
      createdAt: client.created_at,
      clientId: client.client_id,
      tokens,
      count: client.active_token_count,
      incomplete: client.active_token_count > tokens.length,
    }
  })
  const byName = new Map<string, TokenGroup>()
  for (const token of owners) {
    if (covered.has(token.id) || token.label === "DataConnect console" || token.label === "dataconnect-console") continue
    const name = scriptName(token.label)
    let group = byName.get(name)
    if (!group) {
      group = {
        key: `owner-${byName.size}`,
        name,
        createdAt: token.createdAt,
        tokens: [],
        count: 0,
      }
      byName.set(name, group)
      groups.push(group)
    }
    group.tokens.push({ id: token.id, createdAt: token.createdAt })
    group.count++
  }
  return groups
}
export function madeDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "Date not known"
    : `Made ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`
}
export function buildTokenPractice(state: string) {
  if (!["none", "scripts", "created", "many"].includes(state)) return null
  const clients: OwnerIssuedClient[] =
    state === "none"
      ? []
      : [
          {
            client_id: "practice-backup",
            client_name: "Backup script",
            created_at: "2026-11-24T10:00:00Z",
            active_token_count: state === "many" ? 73 : 3,
          },
          {
            client_id: "practice-notes",
            client_name: "Notes tool",
            created_at: "2026-11-24T10:00:00Z",
            active_token_count: 1,
          },
        ]
  const details: Record<string, OwnerClientToken[]> = Object.fromEntries(
    clients.map(client => [
      client.client_id,
      Array.from({ length: client.active_token_count }, (_, index) => ({
        object: "owner_client_token",
        token_id_public: `practice-${client.client_id}-${index}`,
        token_kind: "owner",
        created_at: client.created_at,
        expires_at: null,
      })),
    ])
  )
  return {
    clients,
    details,
    owners: [] as OwnerBearerView[],
    created: state === "created" ? "practice-token-not-a-credential" : null,
  }
}
