// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct `issueToken` on PostgreSQL must commit the token row, the single-use
 * grant consumption, and the `token.issued` audit event together. The audit
 * insert used to run after the token transaction had committed, so an audit
 * failure left the grant consumed with a live token and no audit row, and a
 * retry could never succeed.
 *
 * A trigger on `spine_events` injects the audit failure. After it is removed,
 * the same call must succeed exactly once, which proves the failed attempt
 * left the grant retryable.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { issueToken } from "../server/auth.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const INJECTED_AUDIT_FAILURE_RE = /injected direct token audit failure/;

const GRANT_ID = "grt_direct_audit_fixture";
const CLIENT_ID = "client_direct_audit_fixture";
const ISSUED_AT = "2026-08-11T12:00:00Z";

async function seedSingleUseGrant(): Promise<void> {
  const grant = {
    access_mode: "single_use",
    client: { client_id: CLIENT_ID },
    grant_id: GRANT_ID,
    issued_at: ISSUED_AT,
    purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
    source: { id: "https://source.example/audit-fixture", kind: "connector" },
    source_declaration: { version: "1.0.0" },
    streams: [
      {
        fields: ["id", "name"],
        instance_ids: ["cin_audit_fixture"],
        name: "items",
      },
    ],
    subject: { id: "owner_local" },
    version: "0.1.0",
  };
  await postgresQuery(
    `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json,
                        access_mode, status, consumed, issued_at, expires_at)
     VALUES($1, 'owner_local', $2, $3::jsonb, $4::jsonb, 'single_use', 'active', FALSE, $5, NULL)`,
    [GRANT_ID, CLIENT_ID, JSON.stringify({ connector_id: "audit_fixture" }), JSON.stringify(grant), ISSUED_AT]
  );
}

async function grantState(): Promise<{
  audit_count: number;
  consumed: boolean;
  token_count: number;
}> {
  const result = await postgresQuery<{
    audit_count: number;
    consumed: boolean;
    token_count: number;
  }>(
    `SELECT g.consumed,
            (SELECT COUNT(*)::int FROM tokens t WHERE t.grant_id = g.grant_id) AS token_count,
            (SELECT COUNT(*)::int FROM spine_events e
              WHERE e.grant_id = g.grant_id AND e.event_type = 'token.issued') AS audit_count
       FROM grants g
      WHERE g.grant_id = $1`,
    [GRANT_ID]
  );
  const row = result.rows[0];
  assert.ok(row, "fixture grant must exist");
  return row;
}

test("direct single-use issuance rolls back token and consumption when the audit insert fails", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_token_audit_${randomBytes(4).toString("hex")}`,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await seedSingleUseGrant();
      await postgresQuery(`
          CREATE FUNCTION reject_direct_token_audit() RETURNS trigger AS $$
          BEGIN
            IF NEW.event_type = 'token.issued' AND NEW.grant_id = '${GRANT_ID}' THEN
              RAISE EXCEPTION 'injected direct token audit failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER reject_direct_token_audit
          BEFORE INSERT ON spine_events FOR EACH ROW EXECUTE FUNCTION reject_direct_token_audit();
        `);
      const issue = () => issueToken(GRANT_ID, "owner_local", CLIENT_ID, null);

      await assert.rejects(issue, INJECTED_AUDIT_FAILURE_RE);
      assert.deepEqual(await grantState(), {
        audit_count: 0,
        consumed: false,
        token_count: 0,
      });

      await postgresQuery("DROP TRIGGER reject_direct_token_audit ON spine_events");
      const token = await issue();
      assert.equal(typeof token, "string");
      assert.deepEqual(await grantState(), {
        audit_count: 1,
        consumed: true,
        token_count: 1,
      });
    }
  );
});
