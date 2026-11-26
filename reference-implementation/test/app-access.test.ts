// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as spine from "../lib/spine.ts";
import { postgresListAppAccess } from "../lib/postgres-spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { removeAppAccess } from "../lib/remove-app-access.ts";
import { revokeGrant, revokeGrantPackage, requirePersistedGrantState } from "../server/auth.ts";
import type { AppAccess } from "../lib/app-access.ts";

const NOW = "2026-11-25T00:00:00.000Z";
const ISSUED = "2025-01-01T00:00:00.000Z";
type Write = (sql: string, values: (string | null)[]) => Promise<unknown>;

export async function seedAppAccess(write: Write): Promise<void> {
  for (const [id, status, expiry, client, connection, kind] of [
    ["in_force", "active", null, "app", "cin_mail", "messages"],
    ["second", "active", "2027-01-01T00:00:00.000Z", "app", "cin_mail", "threads"],
    ["sibling", "active", null, "app", "cin_other", "messages"],
    ["removed", "revoked", null, "removed_app", "cin_mail", "messages"],
    ["ran_out", "active", "2026-01-01T00:00:00.000Z", "expired_app", "cin_mail", "messages"],
    ["foreign", "active", null, "foreign_app", "cin_mail", "messages"],
  ] as const) {
    const owner = id === "foreign" ? "other_owner" : "owner_apps";
    await write(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json,
      storage_binding_json, trust_signal_json, access_mode, status, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'continuous', ?, ?, ?)`,
      [
        id,
        owner,
        client,
        JSON.stringify({
          version: "0.1.0",
          grant_id: id,
          subject: { id: owner },
          client: { client_id: client },
          access_mode: "continuous",
          issued_at: ISSUED,
          ...(expiry ? { expires_at: expiry } : {}),
          purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
          source: { kind: "connector", id: "https://sources.example/mail" },
          source_declaration: { version: "1" },
          streams: [{ name: kind, instance_ids: [connection], fields: ["id"] }],
        }),
        JSON.stringify({ connector_id: "mail" }),
        JSON.stringify({ status: "domain_control_verified" }),
        status,
        ISSUED,
        expiry,
      ],
    );
    await spine.emitSpineEvent({
      event_type: "disclosure.served",
      grant_id: id,
      object_type: "grant",
      object_id: id,
      status: "succeeded",
      occurred_at: "2026-11-24T00:00:00.000Z",
    });
  }
  await write(
    `INSERT INTO oauth_clients(client_id, registration_mode, token_endpoint_auth_method, metadata_json, created_at, updated_at)
    VALUES ('app', 'dynamic', 'none', ?, ?, ?)`,
    [
      JSON.stringify({
        client_name: "Test app",
        redirect_uris: ["http://[::1]/return"],
      }),
      ISSUED,
      ISSUED,
    ],
  );
  await spine.emitSpineEvent({
    event_type: "grant.revoked",
    grant_id: "removed",
    object_type: "grant",
    object_id: "removed",
    status: "succeeded",
    occurred_at: "2026-11-23T00:00:00.000Z",
  });
}

async function sqliteFixture() {
  initDb();
  await seedAppAccess(async (sql, values) =>
    getDb()
      .prepare(sql)
      .run(...values),
  );
  return spine.listAppAccessSqlite("owner_apps", NOW);
}

test("app access reads permission state, not the successful read outcome", async () => {
  try {
    const apps = await sqliteFixture();
    assert.equal(apps.length, 3);
    const app = apps.find((entry) => entry.client_id === "app");
    assert.ok(app);
    assert.equal(app.sources.length, 2);
    assert.equal(app.sources[0]?.in_force, true);
    assert.deepEqual(app.sources.find((s) => s.source.connection_id === "cin_mail")?.kinds, [
      "messages",
      "threads",
    ]);
    assert.equal(app.sources.find((s) => s.source.connection_id === "cin_mail")?.expires_at, null);
    assert.equal(app.reads_last_7_days, 3);
    assert.equal(app.return_host, "::1");
    assert.equal(app.returns_to_this_computer, true);
    assert.equal(app.domain_control_verified, true);
    assert.equal(
      apps.find((entry) => entry.client_id === "removed_app")?.sources[0]?.stopped_reason,
      "removed",
    );
    assert.equal(
      apps.find((entry) => entry.client_id === "expired_app")?.sources[0]?.stopped_reason,
      "expired",
    );
    const old = await spine.listSpineCorrelations("grant", { limit: 50 });
    assert.notEqual(
      old.summaries.find((g) => g.id === "in_force")?.status,
      "active",
      "the old event summary cannot represent the persisted permission lifecycle",
    );
  } finally {
    closeDb();
  }
});

test("Postgres app access equals SQLite for the same persisted fixtures", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  let expected: AppAccess[];
  try {
    expected = await sqliteFixture();
  } finally {
    closeDb();
  }
  await withTemporaryPostgresDatabase(
    {
      connectionString: process.env.PDPP_TEST_POSTGRES_URL as string,
      databaseName: `dc_apps_test_${randomUUID().replaceAll("-", "")}`,
      closeConnections: closePostgresStorage,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await seedAppAccess(async (sql, values) => {
        let index = 0;
        return postgresQuery(
          sql.replaceAll("?", () => `$${++index}`),
          values,
        );
      });
      assert.deepEqual(await postgresListAppAccess("owner_apps", NOW), expected);
    },
  );
});

async function checkRemoval(
  write: Write,
  read: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<void> {
  await seedAppAccess(write);
  const [fixture] = await read(
    "SELECT *, grant_id AS persisted_grant_id, subject_id AS grant_subject_id, client_id AS grant_client_id, access_mode AS grant_access_mode, expires_at AS grant_expires_at FROM grants WHERE grant_id='in_force'",
  );
  assert.ok(fixture);
  requirePersistedGrantState({
    ...fixture,
    grant_json:
      typeof fixture.grant_json === "string" ? fixture.grant_json : JSON.stringify(fixture.grant_json),
    storage_binding_json:
      typeof fixture.storage_binding_json === "string"
        ? fixture.storage_binding_json
        : JSON.stringify(fixture.storage_binding_json),
  });
  await write(
    `INSERT INTO grant_packages(package_id, subject_id, client_id, package_json, created_at, approved_at)
    VALUES ('package', 'owner_apps', 'app', '{}', ?, ?)`,
    [ISSUED, ISSUED],
  );
  for (const id of ["in_force", "second", "sibling"]) {
    await write(
      `INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, added_at)
      VALUES ('package', ?, ?, ?, ?)`,
      [
        id,
        `token_${id}`,
        JSON.stringify({
          kind: "connector",
          id: "https://sources.example/mail",
        }),
        ISSUED,
      ],
    );
    await write(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, created_at)
      VALUES (?, ?, 'owner_apps', 'app', 'client', ?)`,
      [`token_${id}`, id, ISSUED],
    );
  }
  const deps = {
    list: async () => spine.listAppAccess("owner_apps", NOW),
    revokeGrant: (id: string) => revokeGrant(id, { request_id: "remove-request" }),
    revokePackage: (id: string) => revokeGrantPackage(id, { request_id: "remove-request" }),
  };
  await assert.rejects(removeAppAccess({ client_ids: ["app", "foreign_app"] }, deps), { status: 403 });
  assert.equal(
    (await deps.list()).find((app) => app.client_id === "app")?.sources.filter((s) => s.in_force).length,
    2,
  );
  const failed = await removeAppAccess(
    { client_ids: ["app"] },
    {
      ...deps,
      revokeGrant: async () => {
        throw new Error("injected revoke failure");
      },
      revokePackage: async () => {
        throw new Error("injected package failure");
      },
    },
  );
  assert.equal(failed.ended_count, 0);
  assert.equal(failed.failed_count, 3);
  const source = (await deps.list())
    .find((app) => app.client_id === "app")
    ?.sources.find((s) => s.source.connection_id === "cin_mail")?.source;
  assert.ok(source);
  const partial = await removeAppAccess({ client_ids: ["app"], source }, deps);
  assert.equal(partial.ended_count, 2);
  assert.equal(partial.failed_count, 0);
  const after = (await deps.list()).find((app) => app.client_id === "app");
  assert.equal(after?.sources.find((s) => s.source.connection_id === "cin_mail")?.in_force, false);
  assert.equal(after?.sources.find((s) => s.source.connection_id === "cin_other")?.in_force, true);
  assert.equal(
    (await read("SELECT status FROM grant_packages WHERE package_id='package'"))[0]?.status,
    "active",
  );
  assert.equal((await removeAppAccess({ client_ids: ["app"], source }, deps)).ended_count, 0);
  const events = await read(
    "SELECT event_type, actor_id, actor_type, client_id, subject_id, status, request_id, data_json FROM spine_events WHERE grant_id='in_force' AND event_type='grant.revoked'",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actor_id, "pdpp_as");
  assert.equal(events[0]?.actor_type, "authorization_server");
  assert.equal(events[0]?.status, "succeeded");
  assert.equal(events[0]?.client_id, "app");
  assert.equal(events[0]?.subject_id, "owner_apps");
  assert.equal(events[0]?.request_id, "remove-request");
  const body =
    typeof events[0]?.data_json === "string" ? JSON.parse(events[0].data_json) : events[0]?.data_json;
  assert.deepEqual(body.source, {
    kind: "connector",
    id: "https://sources.example/mail",
  });
  const all = await removeAppAccess({ client_ids: ["app"] }, deps);
  assert.equal(all.ended_count, 1);
  assert.equal(all.failed_count, 0);
  assert.equal(
    (await deps.list()).find((app) => app.client_id === "app")?.sources.some((s) => s.in_force),
    false,
  );
  assert.equal(
    (await read("SELECT status FROM grant_packages WHERE package_id='package'"))[0]?.status,
    "revoked",
  );
  assert.equal((await removeAppAccess({ client_ids: ["app"] }, deps)).ended_count, 0);
  assert.equal(
    (await read("SELECT event_id FROM spine_events WHERE event_type='grant_package.revoked'")).length,
    1,
  );
  const tokenRows = await read("SELECT revoked FROM tokens WHERE client_id='app'");
  assert.equal(tokenRows.length, 3);
  assert.ok(tokenRows.every((row) => row.revoked === true || row.revoked === 1));
  assert.equal((await read("SELECT client_id FROM oauth_clients WHERE client_id='app'")).length, 1);

  for (let index = 0; index < 55; index += 1) {
    await write(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, issued_at)
      VALUES (?, 'owner_many_apps', ?, '{}', 'continuous', ?)`,
      [`many_grant_${index}`, `many_app_${index}`, ISSUED],
    );
  }
  const complete = await spine.listAppAccess("owner_many_apps", NOW);
  assert.equal(complete.length, 55, "the list includes registrations beyond the former 50-grant page");
  assert.equal(
    complete.every((app) => app.sources[0]?.in_force),
    true,
  );
}

test("SQLite app removal preserves sibling package access, audit fields, tokens and registration", async () => {
  initDb();
  try {
    await checkRemoval(
      async (sql, values) =>
        getDb()
          .prepare(sql)
          .run(...values),
      async (sql) => getDb().prepare(sql).all() as Record<string, unknown>[],
    );
  } finally {
    closeDb();
  }
});

test("a multi-connection permission attributes reads to the right connection and refuses a partial revoke", async () => {
  try {
    await sqliteFixture();
    const db = getDb();
    const row = db.prepare("SELECT grant_json FROM grants WHERE grant_id='in_force'").get() as {
      grant_json: string;
    };
    const grant = JSON.parse(row.grant_json);
    grant.streams[0].instance_ids.push("cin_other");
    db.prepare("UPDATE grants SET grant_json=? WHERE grant_id='in_force'").run(JSON.stringify(grant));
    await spine.emitSpineEvent({
      event_type: "disclosure.served",
      grant_id: "in_force",
      object_id: "in_force",
      object_type: "grant",
      status: "succeeded",
      occurred_at: "2026-11-24T01:00:00.000Z",
      data: { connector_instance_id: "cin_mail" },
    });
    const apps = await spine.listAppAccess("owner_apps", NOW);
    const app = apps.find((entry) => entry.client_id === "app");
    assert.ok(app);
    const mail = app.sources.find((source) => source.source.connection_id === "cin_mail");
    assert.ok(mail);
    assert.equal(mail.last_read_at, "2026-11-24T01:00:00.000Z");
    assert.equal(
      app.sources.find((source) => source.source.connection_id === "cin_other")?.last_read_at,
      "2026-11-24T00:00:00.000Z",
    );
    let writes = 0;
    await assert.rejects(
      removeAppAccess(
        { client_ids: ["app"], source: mail.source },
        {
          list: async () => apps,
          revokeGrant: async () => {
            writes += 1;
          },
          revokePackage: async () => {
            writes += 1;
          },
        },
      ),
      { status: 400 },
    );
    assert.equal(writes, 0);
  } finally {
    closeDb();
  }
});

test("Postgres app removal preserves sibling package access, audit fields, tokens and registration", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      connectionString: process.env.PDPP_TEST_POSTGRES_URL as string,
      databaseName: `dc_apps_test_${randomUUID().replaceAll("-", "")}`,
      closeConnections: closePostgresStorage,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await checkRemoval(
        async (sql, values) => {
          let index = 0;
          return postgresQuery(
            sql.replaceAll("?", () => `$${++index}`),
            values,
          );
        },
        async (sql) => (await postgresQuery(sql)).rows,
      );
    },
  );
});
