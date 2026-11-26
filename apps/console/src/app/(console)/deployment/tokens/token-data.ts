// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import "server-only";
import { listOwnerClientTokens, listOwnerIssuedClients } from "../../lib/ref-client.ts";
import { loadOwnerSessionInventory } from "../../settings/owner-sessions-data.ts";
import { tokenGroups } from "./token-model.ts";
export async function loadTokenGroups() {
  const [clients, inventory] = await Promise.all([listOwnerIssuedClients(), loadOwnerSessionInventory()]);
  const details = Object.fromEntries(await Promise.all(clients.data.filter(client => client.client_id !== "dataconnect-console").map(async client => [client.client_id, (await listOwnerClientTokens(client.client_id).catch(() => ({ data: [] }))).data] as const)));
  return tokenGroups(clients.data, details, inventory.bearers);
}
