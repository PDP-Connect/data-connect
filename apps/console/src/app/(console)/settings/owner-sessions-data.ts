import "server-only";

import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { redirectToOwnerLogin } from "../lib/login-redirect.ts";
import { getAsInternalUrl, withOwnerSessionCookie } from "../lib/owner-token.ts";

export interface OwnerSessionView {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  ipAddress: string | null;
  current: boolean;
}

export interface OwnerBearerView {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface OwnerSessionInventory {
  enabled: boolean;
  sessions: OwnerSessionView[];
  bearers: OwnerBearerView[];
}

export async function loadOwnerSessionInventory(): Promise<OwnerSessionInventory> {
  await requireDashboardAccess("/settings");
  const asUrl = getAsInternalUrl();
  const response = await fetch(
    `${asUrl}/owner/sessions`,
    await withOwnerSessionCookie({
      cache: "no-store",
      headers: { Accept: "application/json" },
      method: "GET",
    })
  );
  if (response.status === 404) {
    return { enabled: false, sessions: [], bearers: [] };
  }
  if (response.status === 401) {
    await redirectToOwnerLogin("/settings");
  }
  if (!response.ok) {
    throw new Error(`Could not load owner sessions (${response.status}).`);
  }
  const body = (await response.json()) as {
    sessions?: OwnerSessionView[];
    bearers?: OwnerBearerView[];
  };
  return {
    enabled: true,
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    bearers: Array.isArray(body.bearers) ? body.bearers : [],
  };
}
