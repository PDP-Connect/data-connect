// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Postgres path of the coalesced audit write: `emitSpineEvents` puts a
// request's audit pair in one multi-row INSERT, without `RETURNING *`, and
// hashes bearers. Gated on PDPP_TEST_POSTGRES_URL (a provisioned scratch
// database), like the other *-postgres tests.

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent, emitSpineEvents } from "../lib/spine.ts";
import { auditTokenRef } from "../server/audit-token-ref.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  test("emitSpineEvents writes the pair atomically with hashed bearers", async (t) => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    t.after(() => closePostgresStorage());
    const bearer = "a".repeat(64);
    const objectId = `req_batch_${Date.now()}`;
    const written = await emitSpineEvents([
      { event_type: "query.received", object_id: objectId, object_type: "query", status: "started", token_id: bearer },
      {
        data: { error: { code: "not_found" } },
        event_type: "query.rejected",
        object_id: objectId,
        object_type: "query",
        status: "failed",
        token_id: bearer,
      },
    ]);
    assert.equal(written.length, 2);
    assert.equal(written[0]?.token_id, auditTokenRef(bearer));
    assert.deepEqual(written[1]?.data, { error: { code: "not_found" } });

    const { rows } = await postgresQuery<{ event_seq: string; event_type: string; token_id: string; xmin: string }>(
      "SELECT event_seq, event_type, token_id, xmin::text AS xmin FROM spine_events WHERE object_id = $1 ORDER BY event_seq",
      [objectId]
    );
    assert.deepEqual(
      rows.map((r) => r.event_type),
      ["query.received", "query.rejected"]
    );
    assert.equal(rows[0]?.xmin, rows[1]?.xmin, "both rows commit in the same transaction");
    for (const row of rows) {
      assert.equal(row.token_id, auditTokenRef(bearer));
    }

    const single = await emitSpineEvent({ event_type: "token.issued", object_id: bearer, object_type: "token" });
    assert.equal(single?.object_id, auditTokenRef(bearer), "token object ids are hashed too");
  });
} else {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  test("spine batch emit postgres path (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}
