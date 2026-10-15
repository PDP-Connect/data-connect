// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DR "Vacuna al día" pilot: a parent approves and revokes a child's
 * vaccination-record grant (server/pilot-dr-vacuna/, PDPP_PILOT_DR_VACUNA=1).
 *
 * End to end through the real AS/RS on PostgreSQL:
 *   - registry confirms guardianship -> grant.subject = child, grantors =
 *     [{ client-specific id, capacity URI }], expires_at = 18th birthday,
 *     and the client token reads only that child's record;
 *   - registry refuses (no relationship / suspended authority) -> the client
 *     gets an ordinary OAuth access_denied, the audit log names a registry
 *     refusal, and nothing about the child is returned to the person;
 *   - a person without current authority cannot revoke;
 *   - a guardian's revocation needs keep/delete and stops reads at once;
 *   - with the flag off the pilot surface does not exist and a grant
 *     carrying `grantors` is not honoured.
 *
 * Gated on PDPP_TEST_POSTGRES_URL (a scratch database; this file creates the
 * pilot tables and owner-scoped rows it needs).
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55491/pdpp_pilot_test \
 *     node --test --import tsx test/pilot-dr-vacuna-representative-approval-postgres.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseCoreResolvedGrant } from "../server/core-source-authorization.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const PASSWORD = "vacuna-demo-2026";
const CONNECTOR = "dr-vacuna-registry";
const SOURCE_ID = `https://registry.pdpp.dev/connectors/${CONNECTOR}`;
const STREAM = "child_immunizations";
const REDIRECT_URI = "https://reminders.example/callback";

// Cédulas (11 digits) and children seeded into the civil-registry stub.
const MOTHER = "00100000017"; // parent of CHILD_A and CHILD_B
const FATHER = "00100000025"; // second parent of CHILD_A
const SUSPENDED = "00100000033"; // parent of CHILD_B, authority suspended
const STRANGER = "00100000041"; // no relationship to anyone here
const CHILD_A = "DR-9000001";
const CHILD_B = "DR-9000002";
const BIRTH_A = "2023-05-17";
const BIRTH_B = "2021-02-03";

const MANIFEST = {
  capabilities: {
    human_interaction: [],
    public_listing: { tier: "development" },
  },
  connector_id: CONNECTOR,
  connector_key: CONNECTOR,
  display_name: "Registro Nacional de Vacunación (test)",
  manifest_uri: SOURCE_ID,
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: false } } },
  streams: [
    {
      consent_time_field: "updated_at",
      coverage_strategy: "full_inventory",
      cursor_field: "updated_at",
      freshness_strategy: "manual_as_of",
      incremental: true,
      name: STREAM,
      primary_key: ["child_id"],
      schema: {
        properties: {
          birth_date: { format: "date", type: "string" },
          child_id: { type: "string" },
          doses: { items: { type: "object" }, type: "array" },
          updated_at: { format: "date-time", type: "string" },
        },
        required: ["child_id", "birth_date", "doses"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}
type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function boot(): Promise<{
  as: string;
  rs: string;
  server: StartedServer;
}> {
  const server = (await startServer({
    asPort: 0,
    bindHost: "127.0.0.1",
    databaseUrl: POSTGRES_URL,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsPort: 0,
    storageBackend: "postgres" as const,
  } as Parameters<typeof startServer>[0])) as StartedServer;
  return {
    as: `http://127.0.0.1:${server.asPort}`,
    rs: `http://127.0.0.1:${server.rsPort}`,
    server,
  };
}

interface Json {
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
  body: Record<string, any>;
  headers: Headers;
  status: number;
}

async function call(url: string, init: RequestInit = {}): Promise<Json> {
  const resp = await fetch(url, { redirect: "manual", ...init });
  const text = await resp.text();
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { body, headers: resp.headers, status: resp.status };
}

const jsonPost = (payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
  body: JSON.stringify(payload),
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...headers,
  },
  method: "POST",
});
const formPost = (fields: Record<string, string>): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  method: "POST",
});

async function seedRegistryAndData(as: string, rs: string): Promise<string> {
  const registered = await call(`${as}/connectors`, jsonPost(MANIFEST));
  assert.ok([200, 201, 409].includes(registered.status), JSON.stringify(registered.body));
  const device = await call(`${as}/oauth/device_authorization`, formPost({ client_id: "cli_longview" }));
  await fetch(
    `${as}/device/approve`,
    formPost({
      subject_id: "owner_local",
      user_code: String(device.body.user_code),
    })
  );
  const token = await call(
    `${as}/oauth/token`,
    formPost({
      client_id: "cli_longview",
      device_code: String(device.body.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  );
  const ownerToken = String(token.body.access_token);
  const lines = [
    {
      birth_date: BIRTH_A,
      child_id: CHILD_A,
      doses: [],
      updated_at: "2026-09-01T00:00:00Z",
    },
    {
      birth_date: BIRTH_B,
      child_id: CHILD_B,
      doses: [],
      updated_at: "2026-09-01T00:00:00Z",
    },
  ].map((data) => JSON.stringify({ data, emitted_at: data.updated_at, key: data.child_id }));
  const ingest = await call(`${rs}/v1/ingest/${STREAM}?connector_id=${CONNECTOR}`, {
    body: lines.join("\n"),
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/x-ndjson",
    },
    method: "POST",
  });
  assert.equal(ingest.status, 200, JSON.stringify(ingest.body));

  // The pilot creates its tables lazily; make sure they exist before seeding.
  await call(`${as}/pilot/cuenta-unica/login`, jsonPost({ cedula: "0", password: "x" }));
  await postgresQuery("DELETE FROM pilot_rc_guardianships WHERE child_id = ANY($1)", [[CHILD_A, CHILD_B]]);
  await postgresQuery(
    `INSERT INTO pilot_rc_parents (cedula, given_name, family_name) VALUES
       ($1, 'María', 'Peña'), ($2, 'José', 'Peña'), ($3, 'Luis', 'Santos'), ($4, 'Ana', 'Reyes')
     ON CONFLICT DO NOTHING`,
    [MOTHER, FATHER, SUSPENDED, STRANGER]
  );
  await postgresQuery(
    `INSERT INTO pilot_rc_children (child_id, given_name, family_name, birth_date) VALUES
       ($1, 'Sofía', 'Peña', $2), ($3, 'Mateo', 'Peña', $4) ON CONFLICT DO NOTHING`,
    [CHILD_A, BIRTH_A, CHILD_B, BIRTH_B]
  );
  await postgresQuery(
    `INSERT INTO pilot_rc_guardianships (parent_cedula, child_id, capacity, status) VALUES
       ($1, $4, 'parent', 'active'), ($2, $4, 'parent', 'active'),
       ($1, $5, 'parent', 'active'), ($3, $5, 'parent', 'suspended')`,
    [MOTHER, FATHER, SUSPENDED, CHILD_A, CHILD_B]
  );

  const client = await call(
    `${as}/oauth/register`,
    jsonPost({
      client_name: "Recordatorio de Vacunas (test)",
      grant_types: ["authorization_code"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
  );
  assert.equal(client.status, 201, JSON.stringify(client.body));
  return String(client.body.client_id);
}

function detailsFor(childId: string | null) {
  return [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "Recordatorios de vacunación",
      source: { id: SOURCE_ID, kind: "connector" },
      streams: [{ name: STREAM, ...(childId ? { resources: [childId] } : {}) }],
      type: "https://pdpp.dev/data-access",
    },
  ];
}

async function par(as: string, clientId: string, childId: string | null): Promise<string> {
  const res = await call(
    `${as}/oauth/par`,
    jsonPost({
      authorization_details: detailsFor(childId),
      client_id: clientId,
    })
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return String(res.body.request_uri);
}

/** Start like a reminder client: GET /oauth/authorize with PKCE and state. */
async function authorize(as: string, clientId: string, childId: string): Promise<string> {
  const verifier = "v".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${as}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "st-123");
  url.searchParams.set("authorization_details", JSON.stringify(detailsFor(childId)));
  const res = await call(url.toString());
  assert.equal(res.status, 302);
  const consentUrl = new URL(String(res.headers.get("location")));
  // The reference consent link for a pilot-source request lands on the parent surface.
  const consent = await call(`${as}${consentUrl.pathname}${consentUrl.search}`);
  assert.equal(consent.status, 302);
  assert.match(String(consent.headers.get("location")), /^\/pilot\/vacuna\/consent\?request_uri=/);
  return String(consentUrl.searchParams.get("request_uri"));
}

interface Parent {
  cookie: string;
  csrf: string;
}

async function signIn(as: string, cedula: string): Promise<Parent> {
  const res = await call(`${as}/pilot/cuenta-unica/login`, jsonPost({ cedula, password: PASSWORD }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cookie = String(res.headers.get("set-cookie")).split(";")[0] as string;
  return { cookie, csrf: String(res.body.csrf_token) };
}

function asParent(parent: Parent, payload: Record<string, unknown>): RequestInit {
  return jsonPost({ ...payload, csrf_token: parent.csrf }, { Cookie: parent.cookie });
}

async function approveFor(as: string, parent: Parent, requestUri: string, childId?: string) {
  const selected = await call(
    `${as}/pilot/vacuna/consent/select`,
    asParent(parent, {
      request_uri: requestUri,
      ...(childId ? { child_id: childId } : {}),
    })
  );
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const approved = await call(
    `${as}/pilot/vacuna/consent/approve`,
    asParent(parent, {
      pilot_revision: selected.body.pilot_revision,
      request_uri: requestUri,
    })
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { approved: approved.body, selected: selected.body };
}

async function readRecord(rs: string, token: string, childId: string): Promise<number> {
  const res = await fetch(`${rs}/v1/streams/${STREAM}/records/${childId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.arrayBuffer();
  return res.status;
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
async function spine(eventType: string, objectId: string): Promise<Array<Record<string, any>>> {
  const result = await postgresQuery(
    "SELECT actor_id, actor_type, subject_id, status, data_json FROM spine_events WHERE event_type = $1 AND object_id = $2",
    [eventType, objectId]
  );
  return result.rows.map((row) => ({
    ...row,
    data: typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json,
  }));
}

test("grantors are parsed only with the pilot flag on, in the #378 shape", () => {
  const base = {
    access_mode: "continuous",
    client: { client_id: "cli_x" },
    grant_id: "grt_x",
    issued_at: "2026-10-01T00:00:00Z",
    purpose_code: "https://pdpp.dev/purpose/assist_summarize",
    source: { id: SOURCE_ID, kind: "connector" },
    source_declaration: { version: "v1" },
    streams: [
      {
        fields: ["child_id"],
        instance_ids: ["cin_x"],
        name: STREAM,
        resources: [CHILD_A],
      },
    ],
    subject: { id: CHILD_A },
    version: "0.1.0",
  };
  const grantors = [{ capacity: "urn:pdpp:pilot:dr-vacuna:capacity:parent", id: "gtr_a" }];
  const previous = process.env.PDPP_PILOT_DR_VACUNA;
  try {
    delete process.env.PDPP_PILOT_DR_VACUNA;
    assert.throws(() => parseCoreResolvedGrant({ ...base, grantors }), /additional properties/);
    process.env.PDPP_PILOT_DR_VACUNA = "1";
    assert.deepEqual(
      (parseCoreResolvedGrant({ ...base, grantors }) as unknown as Record<string, unknown>).grantors,
      grantors
    );
    assert.throws(() => parseCoreResolvedGrant({ ...base, grantors: [] }), /non-empty/);
    assert.throws(
      () =>
        parseCoreResolvedGrant({
          ...base,
          grantors: [...grantors, ...grantors],
        }),
      /distinct/
    );
    assert.throws(
      () =>
        parseCoreResolvedGrant({
          ...base,
          grantors: [{ capacity: "parent", id: "gtr_a" }],
        }),
      /absolute URI/
    );
    assert.throws(
      () =>
        parseCoreResolvedGrant({
          ...base,
          grantors: [{ ...grantors[0], name: "María" }],
        }),
      /exactly \{ id, capacity \}/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_PILOT_DR_VACUNA;
    } else {
      process.env.PDPP_PILOT_DR_VACUNA = previous;
    }
  }
});

if (POSTGRES_URL) {
  // Runs first: the RI test guard refuses a second server boot once `records` holds rows.
  test.describe("DR pilot flag off: reference behaviour unchanged", () => {
    let as = "";
    let server: StartedServer | undefined;

    test.before(async () => {
      delete process.env.PDPP_PILOT_DR_VACUNA;
      ({ as, server } = await boot());
    });

    test.after(async () => {
      if (server) {
        await closeServer(server);
      }
      await closePostgresStorage();
      closeDb();
    });

    test("no pilot routes and no consent redirect", async () => {
      assert.equal((await call(`${as}/pilot/cuenta-unica/login`)).status, 404);
      assert.equal((await call(`${as}/pilot/vacuna/autorizaciones`)).status, 404);
      const registered = await call(`${as}/connectors`, jsonPost(MANIFEST));
      assert.ok([200, 201, 409].includes(registered.status), JSON.stringify(registered.body));
      const client = await call(
        `${as}/oauth/register`,
        jsonPost({
          client_name: "flag-off",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        })
      );
      const requestUri = await par(as, String(client.body.client_id), CHILD_A);
      const consent = await call(`${as}/consent?request_uri=${encodeURIComponent(requestUri)}`);
      assert.equal(consent.status, 200, "reference consent page, not a redirect");
    });
  });

  test.describe("DR pilot representative approval (flag on)", () => {
    let as = "";
    let rs = "";
    let server: StartedServer | undefined;
    let clientId = "";

    test.before(async () => {
      process.env.PDPP_PILOT_DR_VACUNA = "1";
      ({ as, rs, server } = await boot());
      clientId = await seedRegistryAndData(as, rs);
    });

    test.after(async () => {
      if (server) {
        await closeServer(server);
      }
      await closePostgresStorage();
      closeDb();
      delete process.env.PDPP_PILOT_DR_VACUNA;
    });

    test("confirmed guardian: grant names the child as subject, the parent in grantors, expiry at 18", async () => {
      const mother = await signIn(as, MOTHER);
      const requestUri = await par(as, clientId, CHILD_A);
      const { approved, selected } = await approveFor(as, mother, requestUri);

      assert.equal(selected.acting_as, "parent");
      const grant = approved.grant;
      assert.deepEqual(grant.subject, { id: CHILD_A });
      assert.equal(grant.grantors.length, 1);
      assert.deepEqual(Object.keys(grant.grantors[0]).sort(), ["capacity", "id"]);
      assert.equal(grant.grantors[0].capacity, "urn:pdpp:pilot:dr-vacuna:capacity:parent");
      assert.match(grant.grantors[0].id, /^gtr_/);
      assert.ok(!JSON.stringify(grant).includes(MOTHER), "the cédula never reaches the client");
      assert.equal(grant.expires_at, "2041-05-17T00:00:00.000Z");
      assert.deepEqual(grant.streams[0].resources, [CHILD_A]);

      assert.equal(await readRecord(rs, approved.token, CHILD_A), 200);
      assert.equal(await readRecord(rs, approved.token, CHILD_B), 404);

      const deviceCode = requestUri.split(":").at(-1) as string;
      const [approvedEvent] = await spine("consent.approved", deviceCode);
      assert.equal(approvedEvent?.actor_type, "representative");
      assert.deepEqual(approvedEvent?.data.grantors, grant.grantors);
    });

    test("parent picks a child when the request names no record; grantor id is per client", async () => {
      const mother = await signIn(as, MOTHER);
      const listing = await call(
        `${as}/pilot/vacuna/consent?request_uri=${encodeURIComponent(await par(as, clientId, null))}`,
        {
          headers: { Accept: "application/json", Cookie: mother.cookie },
        }
      );
      assert.deepEqual(listing.body.children.map((c: { child_id: string }) => c.child_id).sort(), [CHILD_A, CHILD_B]);
      const requestUri = await par(as, clientId, null);
      const { approved } = await approveFor(as, mother, requestUri, CHILD_B);
      assert.deepEqual(approved.grant.subject, { id: CHILD_B });
      assert.deepEqual(approved.grant.streams[0].resources, [CHILD_B]);

      const other = await call(
        `${as}/oauth/register`,
        jsonPost({
          client_name: "Otra app",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        })
      );
      const second = await approveFor(as, mother, await par(as, String(other.body.client_id), CHILD_B));
      assert.notEqual(second.approved.grant.grantors[0].id, approved.grant.grantors[0].id);
    });

    test("registry refusal: client gets access_denied, audit records a registry refusal, no child data", async () => {
      const stranger = await signIn(as, STRANGER);
      const requestUri = await authorize(as, clientId, CHILD_A);
      const refused = await call(`${as}/pilot/vacuna/consent/select`, asParent(stranger, { request_uri: requestUri }));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "access_denied");
      assert.equal(refused.body.registry_reason, "no_relationship");
      assert.equal(refused.body.child, undefined);
      const redirect = new URL(String(refused.body.redirect_to));
      assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT_URI);
      assert.equal(redirect.searchParams.get("error"), "access_denied");
      assert.equal(redirect.searchParams.get("state"), "st-123");
      assert.equal(redirect.searchParams.get("error_description"), null, "no refusal cause leaks to the client");

      const deviceCode = requestUri.split(":").at(-1) as string;
      const status = await postgresQuery("SELECT status FROM pending_consents WHERE device_code = $1", [deviceCode]);
      assert.equal(status.rows[0]?.status, "denied");
      const [event] = await spine("representative.authority_refused", deviceCode);
      assert.equal(event?.data.reason, "registry_refusal");
      assert.equal(event?.data.registry_reason, "no_relationship");
      assert.equal(event?.subject_id, CHILD_A);
      const review = await postgresQuery("SELECT approval_review_json FROM pending_consents WHERE device_code = $1", [
        deviceCode,
      ]);
      assert.equal(review.rows[0]?.approval_review_json, null, "no review was built for the child");
    });

    test("suspended authority is refused the same way", async () => {
      const suspended = await signIn(as, SUSPENDED);
      const requestUri = await par(as, clientId, CHILD_B);
      const refused = await call(`${as}/pilot/vacuna/consent/select`, asParent(suspended, { request_uri: requestUri }));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "access_denied");
      assert.equal(refused.body.registry_reason, "authority_suspended");
    });

    test("a person without current authority cannot revoke", async () => {
      const mother = await signIn(as, MOTHER);
      const { approved } = await approveFor(as, mother, await par(as, clientId, CHILD_B));
      const grantId = String(approved.grant_id);
      for (const cedula of [STRANGER, SUSPENDED]) {
        const person = await signIn(as, cedula);
        const res = await call(
          `${as}/pilot/vacuna/autorizaciones/${grantId}/revoke`,
          asParent(person, { disposition: "delete" })
        );
        assert.equal(res.status, 403, cedula);
        const list = await call(`${as}/pilot/vacuna/autorizaciones`, {
          headers: { Accept: "application/json", Cookie: person.cookie },
        });
        assert.ok(!list.body.authorizations.some((a: { grant_id: string }) => a.grant_id === grantId));
      }
      const refusals = await spine("representative.management_refused", grantId);
      assert.equal(refusals.length, 2);
      assert.equal(await readRecord(rs, approved.token, CHILD_B), 200, "grant still active");
    });

    test("revocation by the other parent needs keep/delete and stops reads immediately", async () => {
      const mother = await signIn(as, MOTHER);
      const { approved } = await approveFor(as, mother, await par(as, clientId, CHILD_A));
      const grantId = String(approved.grant_id);
      assert.equal(await readRecord(rs, approved.token, CHILD_A), 200);

      const father = await signIn(as, FATHER);
      const list = await call(`${as}/pilot/vacuna/autorizaciones`, {
        headers: { Accept: "application/json", Cookie: father.cookie },
      });
      const entry = list.body.authorizations.find((a: { grant_id: string }) => a.grant_id === grantId);
      assert.equal(entry?.approved_by_you, false);

      const noChoice = await call(`${as}/pilot/vacuna/autorizaciones/${grantId}/revoke`, asParent(father, {}));
      assert.equal(noChoice.status, 400, "no default disposition");
      assert.equal(await readRecord(rs, approved.token, CHILD_A), 200);

      const revoked = await call(
        `${as}/pilot/vacuna/autorizaciones/${grantId}/revoke`,
        asParent(father, { disposition: "keep" })
      );
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
      assert.equal(revoked.body.disposition, "keep");
      assert.equal(await readRecord(rs, approved.token, CHILD_A), 403);

      const [event] = await spine("representative.grant_revoked", grantId);
      assert.equal(event?.data.disposition, "keep");
      const again = await call(
        `${as}/pilot/vacuna/autorizaciones/${grantId}/revoke`,
        asParent(father, { disposition: "delete" })
      );
      assert.equal(again.status, 409);
    });

    test("approval re-checks authority: suspended between review and approval is refused", async () => {
      const mother = await signIn(as, MOTHER);
      const requestUri = await par(as, clientId, CHILD_A);
      const selected = await call(`${as}/pilot/vacuna/consent/select`, asParent(mother, { request_uri: requestUri }));
      assert.equal(selected.status, 200);
      await postgresQuery(
        "UPDATE pilot_rc_guardianships SET status = 'suspended' WHERE parent_cedula = $1 AND child_id = $2",
        [MOTHER, CHILD_A]
      );
      try {
        const approved = await call(
          `${as}/pilot/vacuna/consent/approve`,
          asParent(mother, {
            pilot_revision: selected.body.pilot_revision,
            request_uri: requestUri,
          })
        );
        assert.equal(approved.status, 403);
        assert.equal(approved.body.error, "access_denied");
      } finally {
        await postgresQuery(
          "UPDATE pilot_rc_guardianships SET status = 'active' WHERE parent_cedula = $1 AND child_id = $2",
          [MOTHER, CHILD_A]
        );
      }
    });
  });
} else {
  test("DR pilot representative approval (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => undefined);
}
