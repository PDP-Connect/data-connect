// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Cuenta Única stub: the national citizen sign-in, reduced to what the pilot
// needs. A person signs in with their cédula and the fixed demo password and
// gets a short-lived session. A real deployment would run OIDC against the
// national identity provider and receive the cédula as a verified claim.
//
// Sessions live in process memory (a restart signs everyone out).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { demoPassword } from "./config.ts";
import type { CivilRegistry } from "./registry-stub.ts";

export const SESSION_COOKIE = "pilot_cu_session";
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200_000;

export interface ParentSession {
  cedula: string;
  csrfToken: string;
  displayName: string;
  expiresAt: number;
  /** Stable AS-internal identifier for the person (never the cédula). */
  parentRef: string;
  sessionId: string;
}

export function normalizeCedula(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{11}$/.test(digits) ? digits : null;
}

export function formatCedula(cedula: string): string {
  return `${cedula.slice(0, 3)}-${cedula.slice(3, 10)}-${cedula.slice(10)}`;
}

/** AS-internal person reference. Deterministic so audit rows correlate across restarts. */
export function parentRefFor(cedula: string): string {
  return `cu_${createHash("sha256").update(`pilot-dr-vacuna-parent:${cedula}`).digest("hex").slice(0, 24)}`;
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseCookies(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== "string") {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return out;
}

export function createCuentaUnicaStub(registry: CivilRegistry) {
  const sessions = new Map<string, ParentSession>();

  function sweep(now: number): void {
    if (sessions.size < MAX_SESSIONS) {
      return;
    }
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(id);
      }
    }
  }

  return {
    /** Returns null for unknown cédula or wrong password (no distinction). */
    async signIn(rawCedula: unknown, password: unknown): Promise<ParentSession | null> {
      const cedula = normalizeCedula(rawCedula);
      if (!(cedula && typeof password === "string" && sameSecret(password, demoPassword()))) {
        return null;
      }
      const person = await registry.getParent(cedula);
      if (!person) {
        return null;
      }
      const now = Date.now();
      sweep(now);
      const session: ParentSession = {
        cedula,
        csrfToken: randomBytes(18).toString("base64url"),
        displayName: `${person.given_name} ${person.family_name}`,
        expiresAt: now + SESSION_TTL_MS,
        parentRef: parentRefFor(cedula),
        sessionId: randomBytes(24).toString("base64url"),
      };
      sessions.set(session.sessionId, session);
      return session;
    },
    sessionFromRequest(headers: Record<string, unknown> | undefined): ParentSession | null {
      const id = parseCookies(headers?.cookie)[SESSION_COOKIE];
      if (!id) {
        return null;
      }
      const session = sessions.get(id);
      if (!session) {
        return null;
      }
      if (session.expiresAt <= Date.now()) {
        sessions.delete(id);
        return null;
      }
      return session;
    },
    signOut(sessionId: string): void {
      sessions.delete(sessionId);
    },
  };
}

export type CuentaUnicaStub = ReturnType<typeof createCuentaUnicaStub>;

export function sessionCookie(session: ParentSession): string {
  return `${SESSION_COOKIE}=${session.sessionId}; Path=/pilot; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/pilot; HttpOnly; SameSite=Lax; Max-Age=0`;
}
