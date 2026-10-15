// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Seed the civil-registry stub tables for the DR pilot (direct SQL; the stub
// is a stand-in for an external register, so there is no API to go through).
//
//   pilot_rc_children        one row per child (DR-0000001..), birth date from
//                            the same generator as the vaccination records
//   pilot_rc_parents         ~650,000 adults with synthetic cédulas
//   pilot_rc_guardianships   parent / legal_guardian links (some children have two)
//   pilot_rc_refusal_set     the consent attempts the load harness makes to
//                            exercise refusals (default 60,000):
//                              --suspended N   authority suspended (default 10,000)
//                              the rest        a parent asking for a child not theirs
//
// Usage: node seed-registry.ts [--children 980200] [--refusals 60000] [--suspended 10000]
// Env: VACUNA_DATABASE_URL (default postgres://pdpp:pdpp@localhost:55432/pdpp)

import pg from "pg";
import { REGISTRY_SCHEMA_SQL } from "../../../reference-implementation/server/pilot-dr-vacuna/registry-schema.ts";
import { argInt, DATABASE_URL } from "../baseline/lib/common.ts";
import { type Family, generateFamilies } from "./lib/families.ts";

const childTotal = argInt("children", 980_200);
const refusalTotal = argInt("refusals", 60_000);
const suspendedTarget = Math.min(argInt("suspended", 10_000), refusalTotal);
const FLUSH_FAMILIES = 10_000;

interface Batch {
  children: { birth: string[]; family: string[]; given: string[]; id: string[] };
  links: { capacity: string[]; cedula: string[]; child: string[]; status: string[] };
  parents: { cedula: string[]; family: string[]; given: string[] };
}

function emptyBatch(): Batch {
  return {
    children: { birth: [], family: [], given: [], id: [] },
    links: { capacity: [], cedula: [], child: [], status: [] },
    parents: { cedula: [], family: [], given: [] },
  };
}

async function flush(client: pg.PoolClient, batch: Batch): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO pilot_rc_parents (cedula, given_name, family_name)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
    [batch.parents.cedula, batch.parents.given, batch.parents.family]
  );
  await client.query(
    `INSERT INTO pilot_rc_children (child_id, given_name, family_name, birth_date)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::date[]) ON CONFLICT DO NOTHING`,
    [batch.children.id, batch.children.given, batch.children.family, batch.children.birth]
  );
  await client.query(
    `INSERT INTO pilot_rc_guardianships (parent_cedula, child_id, capacity, status)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
     ON CONFLICT (parent_cedula, child_id) DO UPDATE SET capacity = EXCLUDED.capacity, status = EXCLUDED.status`,
    [batch.links.cedula, batch.links.child, batch.links.capacity, batch.links.status]
  );
  await client.query("COMMIT");
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const startedAt = Date.now();
  const suspended: Array<{ cedula: string; child: string }> = [];
  const crossCandidates: Array<{ cedula: string; child: string }> = [];
  const crossTarget = refusalTotal - suspendedTarget;
  // ~566k families for 980,200 children; sample evenly for cross-family attempts.
  const crossStride = Math.max(1, Math.floor(childTotal / 1.73 / (crossTarget + 2)));
  let families = 0;
  let parents = 0;
  let links = 0;
  let twoParentChildren = 0;
  let guardianOnly = 0;
  try {
    await client.query(REGISTRY_SCHEMA_SQL);
    let batch = emptyBatch();
    const add = (family: Family) => {
      const twoParents = family.parents.length === 2;
      const suspendSecond = twoParents && family.index % 8 === 0 && suspended.length < suspendedTarget;
      for (const p of family.parents) {
        batch.parents.cedula.push(p.cedula);
        batch.parents.given.push(p.given_name);
        batch.parents.family.push(p.family_name);
      }
      for (const c of family.children) {
        batch.children.id.push(c.child_id);
        batch.children.given.push(c.given_name);
        batch.children.family.push(c.family_name);
        batch.children.birth.push(c.birth_date);
      }
      for (const g of family.guardianships) {
        const isSuspended = suspendSecond && g.parent_cedula === family.parents[1]?.cedula;
        batch.links.cedula.push(g.parent_cedula);
        batch.links.child.push(g.child_id);
        batch.links.capacity.push(g.capacity);
        batch.links.status.push(isSuspended ? "suspended" : "active");
      }
      if (suspendSecond) {
        suspended.push({
          cedula: (family.parents[1] as { cedula: string }).cedula,
          child: family.children[0]?.child_id as string,
        });
      }
      // Sample up to refusalTotal + 1 so cross-family attempts can make up for
      // suspensions a tiny registry cannot produce (no two-parent family).
      if (family.index % crossStride === 0 && crossCandidates.length < refusalTotal + 1) {
        crossCandidates.push({
          cedula: family.parents[0]?.cedula as string,
          child: family.children[0]?.child_id as string,
        });
      }
      parents += family.parents.length;
      links += family.guardianships.length;
      twoParentChildren += twoParents ? family.children.length : 0;
      guardianOnly += family.guardianships[0]?.capacity === "legal_guardian" ? family.children.length : 0;
    };
    for (const family of generateFamilies(childTotal)) {
      families += 1;
      add(family);
      if (families % FLUSH_FAMILIES === 0) {
        await flush(client, batch);
        batch = emptyBatch();
        if (families % 100_000 === 0) {
          console.log(
            `[registry] ${families} families, ${parents} adults (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`
          );
        }
      }
    }
    await flush(client, batch);

    // Refusal attempts: suspended authority, then a parent asking for the next
    // sampled family's child (no relationship).
    const attempts: Array<{ cedula: string; child: string; reason: string }> = suspended.map((s) => ({
      ...s,
      reason: "authority_suspended",
    }));
    for (let j = 0; j + 1 < crossCandidates.length && attempts.length < refusalTotal; j++) {
      attempts.push({
        cedula: (crossCandidates[j] as { cedula: string }).cedula,
        child: (crossCandidates[j + 1] as { child: string }).child,
        reason: "no_relationship",
      });
    }
    await client.query("TRUNCATE pilot_rc_refusal_set");
    await client.query(
      `INSERT INTO pilot_rc_refusal_set (seq, parent_cedula, child_id, expected_reason)
       SELECT ord::int, c, ch, r FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS u(c, ch, r, ord)`,
      [attempts.map((a) => a.cedula), attempts.map((a) => a.child), attempts.map((a) => a.reason)]
    );
    await client.query("ANALYZE pilot_rc_parents; ANALYZE pilot_rc_children; ANALYZE pilot_rc_guardianships");
    const summary = {
      adults: parents,
      children: childTotal,
      children_with_two_parents: twoParentChildren,
      children_with_legal_guardian: guardianOnly,
      families,
      guardianships: links,
      refusal_attempts: attempts.length,
      refusal_attempts_suspended: suspended.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
