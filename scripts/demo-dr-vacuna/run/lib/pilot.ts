// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared client-side helpers for the run scripts: the reminder service's
// confidential client and store, refresh of a child's tokens through the
// real token endpoint, and parent (Cuenta Única stub) sessions for the
// pilot revoke path.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "undici";
import { type ClientCredentials, loadOrCreateClientKey, privateKeyJwtClient, rotateRefreshToken } from "../../reminder-service/lib/oauth.ts";
import { ReminderStore } from "../../reminder-service/lib/store.ts";
import { AS_URL } from "./plan.ts";

const PASSWORD = process.env.PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD || "vacuna-demo-2026";

export function reminderClient(reminderState: string): ClientCredentials {
  const state = JSON.parse(readFileSync(join(reminderState, "client.json"), "utf8")) as { clientId: string };
  const { key, kid } = loadOrCreateClientKey(join(reminderState, "client-key.pem"));
  return privateKeyJwtClient({ clientId: state.clientId, issuer: process.env.VACUNA_AS_ISSUER || AS_URL, key, kid });
}

export function openStore(reminderState: string): ReminderStore {
  return new ReminderStore(join(reminderState, "reminder.sqlite"));
}

/**
 * Rotates child `index`'s refresh token so its access token is fresh (the AS
 * mints 10-minute access tokens). Uses the reminder service's own rotation
 * code, which commits the new pair to its store before returning.
 */
export async function freshAccessToken(
  store: ReminderStore,
  client: ClientCredentials,
  index: number
): Promise<string | null> {
  const outcome = await rotateRefreshToken({
    childIndex: index,
    client,
    store,
    tokenEndpoint: `${AS_URL}/oauth/token`,
  });
  return outcome.kind === "refreshed" ? outcome.accessToken : null;
}

export const keepAlive = (connections: number) => new Agent({ connections, keepAliveTimeout: 30_000 });

interface Session {
  cookie: string;
  csrf: string;
}

/** Parent sign-in and the pilot's "Mis autorizaciones" revoke, over the JSON path. */
export class ParentPortal {
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly dispatcher: Agent;
  constructor(dispatcher: Agent) {
    this.dispatcher = dispatcher;
  }

  private async post(path: string, payload: unknown, cookie?: string) {
    const res = await fetch(`${AS_URL}${path}`, {
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    } as RequestInit);
    // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { body, headers: res.headers, status: res.status };
  }

  session(cedula: string): Promise<Session> {
    let s = this.sessions.get(cedula);
    if (!s) {
      s = this.post("/pilot/cuenta-unica/login", { cedula, password: PASSWORD }).then((res) => {
        if (res.status !== 200) {
          throw new Error(`login ${cedula}: HTTP ${res.status}`);
        }
        return { cookie: String(res.headers.get("set-cookie")).split(";")[0] as string, csrf: String(res.body.csrf_token) };
      });
      this.sessions.set(cedula, s);
      s.catch(() => this.sessions.delete(cedula));
    }
    return s;
  }

  /** Revoke with the parent's keep-or-delete choice; returns the HTTP status and body. */
  async revoke(cedula: string, grantId: string, disposition: "keep" | "delete") {
    const session = await this.session(cedula);
    return await this.post(
      `/pilot/vacuna/autorizaciones/${encodeURIComponent(grantId)}/revoke`,
      { csrf_token: session.csrf, disposition },
      session.cookie
    );
  }
}
