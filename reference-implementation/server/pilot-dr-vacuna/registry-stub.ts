// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Civil registry stub (Junta Central Electoral / Oficialía del Estado Civil
// stand-in) for the DR pilot. Answers one question for the AS: may this
// person act for this child, and in which capacity?
//
// Backed by seeded tables (scripts/demo-dr-vacuna/consent/seed-registry.ts).
// It runs in-process against the same Postgres for the demo; the AS only uses
// the CivilRegistry interface, so a real registry client can replace it.
//
// Configurable refusals: a guardianship row with status 'suspended' is
// refused with reason `authority_suspended`; a pair with no row is refused
// with `no_relationship`. `pilot_rc_refusal_set` lists the attempts the load
// harness makes to exercise refusals (it does not change the answers).

import { postgresQuery } from "../postgres-storage.ts";
import { type GuardianCapacity, registryLatencyMs } from "./config.ts";
import { REGISTRY_SCHEMA_SQL } from "./registry-schema.ts";

export type GuardianVerdict =
  | { capacity: GuardianCapacity; ok: true }
  | {
      ok: false;
      reason: "authority_suspended" | "no_relationship" | "unknown_child" | "unknown_parent";
    };

export interface RegistryChild {
  birth_date: string;
  child_id: string;
  family_name: string;
  given_name: string;
}

export interface RegistryParent {
  cedula: string;
  family_name: string;
  given_name: string;
}

export interface CivilRegistry {
  getChild(childId: string): Promise<RegistryChild | null>;
  getParent(cedula: string): Promise<RegistryParent | null>;
  isGuardian(parentCedula: string, childId: string): Promise<GuardianVerdict>;
  /** Children the person currently has active authority for. */
  listChildren(parentCedula: string): Promise<Array<RegistryChild & { capacity: GuardianCapacity }>>;
}

export async function ensureRegistrySchema(): Promise<void> {
  await postgresQuery(REGISTRY_SCHEMA_SQL);
}

function delay(): Promise<void> {
  const ms = registryLatencyMs();
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isoDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function toChild(row: Record<string, unknown>): RegistryChild {
  return {
    birth_date: isoDate(row.birth_date),
    child_id: String(row.child_id),
    family_name: String(row.family_name),
    given_name: String(row.given_name),
  };
}

export function createPostgresCivilRegistry(): CivilRegistry {
  return {
    async getChild(childId) {
      await delay();
      const result = await postgresQuery(
        "SELECT child_id, given_name, family_name, birth_date FROM pilot_rc_children WHERE child_id = $1",
        [childId]
      );
      const row = result.rows[0];
      return row ? toChild(row) : null;
    },
    async getParent(cedula) {
      const result = await postgresQuery(
        "SELECT cedula, given_name, family_name FROM pilot_rc_parents WHERE cedula = $1",
        [cedula]
      );
      const row = result.rows[0];
      return row
        ? {
            cedula: String(row.cedula),
            family_name: String(row.family_name),
            given_name: String(row.given_name),
          }
        : null;
    },
    async isGuardian(parentCedula, childId) {
      await delay();
      const result = await postgresQuery(
        `SELECT (SELECT 1 FROM pilot_rc_parents WHERE cedula = $1) AS parent_known,
                (SELECT 1 FROM pilot_rc_children WHERE child_id = $2) AS child_known,
                g.capacity, g.status
           FROM (SELECT 1) AS one
           LEFT JOIN pilot_rc_guardianships g ON g.parent_cedula = $1 AND g.child_id = $2`,
        [parentCedula, childId]
      );
      const row = result.rows[0] ?? {};
      if (!row.parent_known) {
        return { ok: false, reason: "unknown_parent" };
      }
      if (!row.child_known) {
        return { ok: false, reason: "unknown_child" };
      }
      if (!row.capacity) {
        return { ok: false, reason: "no_relationship" };
      }
      if (row.status !== "active") {
        return { ok: false, reason: "authority_suspended" };
      }
      return { capacity: row.capacity as GuardianCapacity, ok: true };
    },
    async listChildren(parentCedula) {
      await delay();
      const result = await postgresQuery(
        `SELECT c.child_id, c.given_name, c.family_name, c.birth_date, g.capacity
           FROM pilot_rc_guardianships g
           JOIN pilot_rc_children c ON c.child_id = g.child_id
          WHERE g.parent_cedula = $1 AND g.status = 'active'
          ORDER BY c.birth_date, c.child_id`,
        [parentCedula]
      );
      return result.rows.map((row) => ({
        ...toChild(row),
        capacity: row.capacity as GuardianCapacity,
      }));
    },
  };
}

/** Day the child turns 18 (UTC midnight): the latest a parent-approved grant may expire. */
export function eighteenthBirthday(birthDate: string): string {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  // 29 February births roll to 1 March in non-leap years (Date.UTC normalizes).
  return new Date(Date.UTC(y + 18, m - 1, d)).toISOString();
}
