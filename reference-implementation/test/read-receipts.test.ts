// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Register read receipts (server/read-receipts.ts): one signed receipt per
// served single-record client read, behind PDPP_READ_RECEIPTS.

import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createReadReceiptHook, READ_RECEIPT_HEADER } from "../server/read-receipts.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

interface DecodedReceipt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: Buffer;
}

function decodeReceipt(value: string): DecodedReceipt {
  const [h, p, s] = value.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
    signature: Buffer.from(s, "base64url"),
    signingInput: Buffer.from(`${h}.${p}`, "ascii"),
  };
}

test("receipt hook signs body hash, grant id, read id and time (Ed25519 and secp256k1)", () => {
  for (const [type, curve] of [
    ["ed25519", undefined],
    ["ec", "secp256k1"],
  ] as const) {
    const { privateKey, publicKey } =
      type === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: curve as string });
    const hook = createReadReceiptHook({ key: privateKey, now: () => new Date("2026-10-14T12:00:00.000Z") });
    const headers = new Map<string, string>();
    const body = { child_id: "DO-0000001", doses: [] };
    const sent = hook.sign({ setHeader: (n, v) => headers.set(n, v) }, { body, grantId: "grt_1", requestId: "req_1" });
    assert.equal(sent, JSON.stringify(body));
    const receipt = decodeReceipt(headers.get(READ_RECEIPT_HEADER) as string);
    assert.equal(receipt.payload.record_sha256, createHash("sha256").update(sent).digest("hex"));
    assert.equal(receipt.payload.grant_id, "grt_1");
    assert.equal(receipt.payload.request_id, "req_1");
    assert.equal(receipt.payload.served_at, "2026-10-14T12:00:00.000Z");
    assert.match(String(receipt.payload.read_id), /^0x[0-9a-f]{64}$/);
    const ok =
      receipt.header.alg === "EdDSA"
        ? verify(null, receipt.signingInput, publicKey, receipt.signature)
        : verify("sha256", receipt.signingInput, { dsaEncoding: "ieee-p1363", key: publicKey }, receipt.signature);
    assert.ok(ok, `${type} receipt verifies`);
    if (type === "ed25519") {
      const tampered = Buffer.from(receipt.signingInput);
      tampered.writeUInt8((tampered.at(-2) ?? 0) ^ 1, tampered.length - 2);
      assert.equal(verify(null, tampered, publicKey, receipt.signature), false, "tampered receipt fails");
    }
    assert.equal(hook.stats().receipts_signed, 1);
  }
});

const STREAM = "child_immunizations";
const MANIFEST = {
  capabilities: { human_interaction: [], public_listing: { tier: "development" } },
  connector_id: "receipt-test-registry",
  connector_key: "receipt-test-registry",
  display_name: "Receipt test registry",
  manifest_uri: "https://registry.pdpp.dev/connectors/receipt-test-registry",
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
          child_id: { type: "string" },
          doses: { items: { type: "object" }, type: "array" },
          updated_at: { format: "date-time", type: "string" },
        },
        required: ["child_id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

async function call(url: string, init: RequestInit = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { body, headers: resp.headers, status: resp.status, text };
}

const json = (payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
  body: JSON.stringify(payload),
  headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
  method: "POST",
});
const form = (fields: Record<string, string>): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  method: "POST",
});

test("HTTP: a served client record read carries a verifiable receipt; a denied read carries none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-receipts-"));
  const saved = {
    PDPP_READ_RECEIPTS: process.env.PDPP_READ_RECEIPTS,
    PDPP_READ_RECEIPTS_KEY_FILE: process.env.PDPP_READ_RECEIPTS_KEY_FILE,
    PDPP_READ_RECEIPTS_LOG: process.env.PDPP_READ_RECEIPTS_LOG,
  };
  process.env.PDPP_READ_RECEIPTS = "1";
  process.env.PDPP_READ_RECEIPTS_KEY_FILE = join(dir, "receipt-key.pem");
  process.env.PDPP_READ_RECEIPTS_LOG = join(dir, "receipts.jsonl");
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    ownerAuthPassword: "",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    rsPort: 0,
  } as Parameters<typeof startServer>[0])) as unknown as {
    asPort: number;
    asServer: { close: (cb: () => void) => unknown; closeAllConnections?: () => void };
    rsPort: number;
    rsServer: { close: (cb: () => void) => unknown; closeAllConnections?: () => void };
  };
  t.after(async () => {
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
      new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
    ]);
    closeDb();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = v;
      }
    }
  });
  const asUrl = `http://127.0.0.1:${server.asPort}`;
  const rsUrl = `http://127.0.0.1:${server.rsPort}`;

  assert.equal((await call(`${asUrl}/connectors`, json(MANIFEST))).status, 201);
  const device = await call(`${asUrl}/oauth/device_authorization`, form({ client_id: "cli_longview" }));
  await fetch(`${asUrl}/device/approve`, form({ subject_id: "owner_local", user_code: String(device.body.user_code) }));
  const owner = await call(
    `${asUrl}/oauth/token`,
    form({
      client_id: "cli_longview",
      device_code: String(device.body.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  );
  const ownerToken = String(owner.body.access_token);
  const lines = ["DO-A", "DO-B"].map((id) =>
    JSON.stringify({
      data: { child_id: id, doses: [], updated_at: "2026-10-01T00:00:00.000Z" },
      emitted_at: "2026-10-01T00:00:00.000Z",
      key: id,
    })
  );
  const ingest = await call(`${rsUrl}/v1/ingest/${STREAM}?connector_id=${MANIFEST.connector_id}`, {
    body: lines.join("\n"),
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
    method: "POST",
  });
  assert.equal(ingest.status, 200, JSON.stringify(ingest.body));

  const client = await call(
    `${asUrl}/oauth/register`,
    json({
      grant_types: ["authorization_code"],
      redirect_uris: ["https://reminders.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
  );
  const par = await call(
    `${asUrl}/oauth/par`,
    json({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/assist_summarize",
          source: { id: MANIFEST.manifest_uri, kind: "connector" },
          streams: [{ name: STREAM, resources: ["DO-A"] }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: client.body.client_id,
    })
  );
  assert.equal(par.status, 201, JSON.stringify(par.body));
  const review = await call(
    `${asUrl}/consent/review`,
    json({ request_uri: par.body.request_uri, subject_id: "owner_local" })
  );
  const approved = await call(
    `${asUrl}/consent/approve`,
    json({ approval_review_revision: review.body.approval_review_revision, request_uri: par.body.request_uri })
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const token = String(approved.body.token);
  const grantId = String(approved.body.grant_id);

  const served = await call(`${rsUrl}/v1/streams/${STREAM}/records/DO-A`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(served.status, 200, served.text);
  const headerValue = served.headers.get(READ_RECEIPT_HEADER);
  assert.ok(headerValue, "served record carries a receipt");
  const receipt = decodeReceipt(headerValue);
  const publicKey = createPublicKey(readFileSync(join(dir, "receipt-key.pem.pub"), "utf8"));
  assert.ok(verify(null, receipt.signingInput, publicKey, receipt.signature), "receipt verifies with the register key");
  assert.equal(receipt.payload.record_sha256, createHash("sha256").update(served.text).digest("hex"));
  assert.equal(receipt.payload.grant_id, grantId);
  assert.equal(served.body.child_id ?? (served.body.data as Record<string, unknown> | undefined)?.child_id, "DO-A");

  const denied = await call(`${rsUrl}/v1/streams/${STREAM}/records/DO-B`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get(READ_RECEIPT_HEADER), null);

  const log = readFileSync(join(dir, "receipts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[0].type, "key");
  assert.deepEqual(
    log.filter((l) => l.type === "receipt").map((l) => l.read_id),
    [receipt.payload.read_id]
  );
});
