// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createConsentChallengeStore } from "../server/stores/consent-challenge-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const postgresUrl =
  dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL) ?? process.env.PDPP_CONSENT_CHALLENGE_TEST_POSTGRES_URL;

if (postgresUrl) {
  test("Postgres consent challenges persist, expire, and consume atomically", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: postgresUrl,
        databaseName: "pdpp_test_consent_challenge_store",
      },
      async (databaseUrl) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const createdAt = Date.now();
        const record = {
          authorizeParams: { client_id: "client", redirect_uri: "https://client.example/callback" },
          client: { client_id: "client", registration_mode: "pre_registered_public" },
          createdAt,
          expiresAt: createdAt + 30 * 60 * 1000,
          id: "cc_postgres_restart_proof",
          ownerSubjectId: "owner_local",
          renderModelInputs: { trust: "unverified" },
        };
        await createConsentChallengeStore().create(record);

        const restartedStore = createConsentChallengeStore();
        assert.deepEqual(await restartedStore.readPending(record.id, record.ownerSubjectId), record);
        assert.equal(await restartedStore.readPending("cc_postgres_tampered", record.ownerSubjectId), null);
        assert.deepEqual(
          await restartedStore.consume(record.id, record.ownerSubjectId, "accepted", "sha256:decision"),
          record
        );
        assert.equal(
          await createConsentChallengeStore().consume(record.id, record.ownerSubjectId, "accepted", "sha256:replay"),
          null
        );

        const expired = { ...record, expiresAt: createdAt - 1, id: "cc_postgres_expired" };
        await createConsentChallengeStore().create(expired);
        assert.equal(await createConsentChallengeStore().readPending(expired.id, expired.ownerSubjectId), null);
        const rows = await postgresQuery<{ decision_digest: string | null; status: string }>(
          "SELECT status, decision_digest FROM consent_challenges WHERE id = ANY($1)",
          [[record.id, expired.id]]
        );
        assert.deepEqual(
          rows.rows.sort((a, b) => a.status.localeCompare(b.status)),
          [
            { decision_digest: "sha256:decision", status: "accepted" },
            { decision_digest: null, status: "expired" },
          ]
        );
      }
    );
  });
} else {
  test("Postgres consent challenge store (skipped: no dedicated test database URL)", { skip: true }, () => {
    // The local runner has no explicitly provisioned PostgreSQL test database.
  });
}
