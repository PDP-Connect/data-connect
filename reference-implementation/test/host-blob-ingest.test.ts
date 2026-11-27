// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host BLOB ingest through the reference runtime.
 *
 * Profile: memory-default, in-process RS, canned connector child process.
 *
 * Each test states the behavior it pins and the defect that would break it. A
 * lower-level test cannot stand in: the defects here sit between the connector
 * child process, the spool directory, the runtime's ordering rules and the RS
 * blob store, so only a real run crosses all four.
 *
 * Wire shape (packages/connector-protocol): the connector writes a closed JSON
 * file into the directory named by PDPP_BLOB_SPOOL_DIR, emits a BLOB message,
 * then emits the RECORD whose `data.blob_ref.blob_id` is `sha256:<hex>`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { closeTestServer, type TestServer } from "./helpers/close-test-server.ts";

const RECORD_AT = "2026-04-18T00:00:00Z";
const MAX_BLOB_BYTES = 64;
const STREAM = "attachments";
const OTHER_STREAM = "notes";
const SERVER_BLOB_ID_RE = /^blob_sha256_[0-9a-f]{64}$/;

type RunConnectorTestOptions = Omit<Parameters<typeof runConnector>[0], "detailGapStore"> & {
  detailGapStore?: unknown;
};
const runConnectorWithGapStore = runConnector as (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;

function admitRunConnection() {
  return async ({
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
  }: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => {
    const subject = ownerSubjectId || "test_user";
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: subject,
    });
    return {
      connectorId: namespace.connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      ownerSubjectId: subject,
    };
  };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "pdpp_cli";
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const device = (await (
    await fetch(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: form,
      method: "POST",
    })
  ).json()) as { device_code: string; user_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "test_user", user_code: device.user_code }).toString(),
    headers: form,
    method: "POST",
  });
  const token = (await (
    await fetch(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: form,
      method: "POST",
    })
  ).json()) as { access_token: string };
  return token.access_token;
}

const BLOB_REF_SCHEMA = {
  properties: {
    blob_id: { type: "string" },
    mime_type: { type: "string" },
    sha256: { type: "string" },
    size_bytes: { type: "integer" },
  },
  required: ["blob_id"],
  type: ["object", "null"],
};

function manifestStream(name: string, withBlobRef: boolean): Record<string, unknown> {
  return {
    name,
    primary_key: ["id"],
    schema: {
      properties: { id: { type: "string" }, ...(withBlobRef ? { blob_ref: BLOB_REF_SCHEMA } : {}) },
      required: ["id"],
      type: "object",
    },
    selection: { fields: true, resources: true },
    semantics: "append_only",
  };
}

let manifestCounter = 0;

/** A manifest that declares BLOB and host_blob_write for the `attachments` stream only. */
function blobManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  manifestCounter += 1;
  return {
    capabilities: { host_blob_write: { max_blob_bytes: MAX_BLOB_BYTES, streams: [STREAM], version: 1 } },
    connector_id: `host-blob-ingest-${manifestCounter}`,
    display_name: "Host Blob Ingest",
    manifest_uri: `https://registry.pdpp.dev/connectors/host-blob-ingest-${manifestCounter}`,
    protocol_capabilities: ["BLOB"],
    protocol_version: "0.1.0",
    streams: [manifestStream(STREAM, true), manifestStream(OTHER_STREAM, true)],
    version: "1.0.0",
    ...overrides,
  };
}

/** One step of the canned connector. */
type Step =
  | { op: "write"; file: string; text: string }
  | { op: "symlink"; file: string; target: string }
  | { op: "emit"; message: Record<string, unknown> };

interface Ids {
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
  readonly text: string;
}

/** Distinct content per key, so one test's blob never satisfies another's assertion. */
function contentFor(key: string): Ids {
  const text = JSON.stringify({ key, ok: true });
  return {
    key,
    sha256: createHash("sha256").update(text).digest("hex"),
    size: Buffer.byteLength(text),
    text,
  };
}

function blobMessage(ids: Ids, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: `${ids.key}.json`,
    key: ids.key,
    mime_type: "application/json",
    sha256: ids.sha256,
    size_bytes: ids.size,
    stream: STREAM,
    type: "BLOB",
    ...overrides,
  };
}

function recordMessage(ids: Ids, refOverrides: Record<string, unknown> = {}, stream = STREAM): Record<string, unknown> {
  return {
    data: {
      blob_ref: {
        blob_id: `sha256:${ids.sha256}`,
        mime_type: "application/json",
        sha256: ids.sha256,
        size_bytes: ids.size,
        ...refOverrides,
      },
      id: ids.key,
    },
    emitted_at: RECORD_AT,
    key: ids.key,
    stream,
    type: "RECORD",
  };
}

const DONE = (records: number) => ({ records_emitted: records, status: "succeeded", type: "DONE" });
const writeStep = (ids: Ids): Step => ({ file: `${ids.key}.json`, op: "write", text: ids.text });
const emit = (message: Record<string, unknown>): Step => ({ message, op: "emit" });

/** The connector, its blob, and its RECORD in the order the wire contract requires. */
function goodSequence(ids: Ids): Step[] {
  return [writeStep(ids), emit(blobMessage(ids)), emit(recordMessage(ids))];
}

interface RunOutcome {
  /** The value of PDPP_BLOB_SPOOL_DIR the connector saw, or null when it was unset. */
  readonly spoolDir: string | null;
  readonly result: RuntimeRunConnectorResult | null;
  readonly thrown: unknown;
}

/** Spawn the canned connector for `steps`, run it to its end, and report what it saw. */
async function runSteps(
  server: TestServer,
  ownerToken: string,
  manifest: Record<string, unknown>,
  steps: readonly Step[],
  options: { exitCode?: number } = {}
): Promise<RunOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-host-blob-test-"));
  const connectorPath = join(dir, "connector.mjs");
  const envPath = join(dir, "env.json");
  writeFileSync(
    connectorPath,
    `
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  const spool = process.env.PDPP_BLOB_SPOOL_DIR ?? null;
  writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ spool }));
  for (const step of ${JSON.stringify(steps)}) {
    if (step.op === 'write') { if (spool) writeFileSync(join(spool, step.file), step.text); }
    else if (step.op === 'symlink') { if (spool) symlinkSync(step.target, join(spool, step.file)); }
    else process.stdout.write(JSON.stringify(step.message) + '\\n');
  }
  rl.close();
  process.exit(${options.exitCode ?? 0});
});
`,
    "utf-8"
  );
  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: admitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: manifest.connector_id as string,
      connectorPath,
      detailGapStore: getDefaultConnectorDetailGapStore(),
      manifest: manifest as never,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${server.rsPort}`,
      scope: { streams: [{ name: STREAM }, { name: OTHER_STREAM }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  }
  let spoolDir: string | null;
  try {
    spoolDir = (JSON.parse(readFileSync(envPath, "utf-8")) as { spool: string | null }).spool;
  } catch {
    spoolDir = null;
  }
  rmSync(dir, { force: true, recursive: true });
  return { result, spoolDir, thrown };
}

function failureOf(outcome: RunOutcome): string {
  return outcome.thrown instanceof Error ? outcome.thrown.message : JSON.stringify(outcome.result);
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, manifest: Record<string, unknown>) {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeTestServer(server as never));
  const registered = await fetch(`http://localhost:${server.asPort}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(registered.status < 300, true, `manifest admitted: ${registered.status}`);
  const ownerToken = await issueOwnerToken(`http://localhost:${server.asPort}`);
  return { ownerToken, server };
}

interface StoredRecord {
  data: { blob_ref?: { blob_id?: string; mime_type?: string; sha256?: string; size_bytes?: number }; id?: string };
  id?: string;
}

async function storedRecords(
  server: TestServer,
  ownerToken: string,
  manifest: Record<string, unknown>,
  stream = STREAM
): Promise<StoredRecord[]> {
  const resp = await fetch(
    `http://localhost:${server.rsPort}/v1/streams/${stream}/records?connector_id=${encodeURIComponent(manifest.connector_id as string)}&limit=100`,
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(resp.status, 200, "records list reads");
  return ((await resp.json()) as { data: StoredRecord[] }).data;
}

async function fetchBlob(server: TestServer, ownerToken: string, manifest: Record<string, unknown>, id: string) {
  return await fetch(
    `http://localhost:${server.rsPort}/v1/blobs/${encodeURIComponent(id)}?connector_id=${encodeURIComponent(manifest.connector_id as string)}`,
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );
}

// Behavior: a connector that declares BLOB is placed, gets a private spool
// directory, and its BLOB+RECORD pair is stored and served. A PROGRESS line
// between the two does not disturb the pairing. The record's blob id is the
// id the RS serves, not the connector's `sha256:` id.
// Defect: ref left as `sha256:...` (unservable); bytes dropped; spool leaked.
// Oracle: owner reads the record and fetches the id it carries.
test("a BLOB-declaring connector runs; its BLOB and RECORD round-trip to bytes the RS serves", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);
  const ids = contentFor("round-trip");
  const outcome = await runSteps(server, ownerToken, manifest, [
    writeStep(ids),
    emit(blobMessage(ids)),
    emit({ message: "uploading", type: "PROGRESS" }),
    emit(recordMessage(ids)),
    emit(DONE(1)),
  ]);

  assert.equal(outcome.thrown, null, failureOf(outcome));
  assert.equal(outcome.result?.status, "succeeded");
  assert.equal(outcome.result?.records_emitted, 1);

  const records = await storedRecords(server, ownerToken, manifest);
  const record = records.find((r) => r.data.id === ids.key);
  const blobId = record?.data.blob_ref?.blob_id ?? "";
  assert.match(blobId, SERVER_BLOB_ID_RE, "the stored ref carries the RS blob id");
  assert.equal(blobId, `blob_sha256_${ids.sha256}`, "the RS id is derived from the content hash");
  assert.equal(record?.data.blob_ref?.sha256, ids.sha256);
  assert.equal(record?.data.blob_ref?.size_bytes, ids.size);

  const response = await fetchBlob(server, ownerToken, manifest, blobId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf-8"), ids.text);

  assert.ok(outcome.spoolDir, "a declaring connector gets a spool directory");
  assert.equal(existsSync(outcome.spoolDir as string), false, "the spool directory is removed after the run");
});

// Behavior: START lists BLOB and only connectors that declare it get a spool.
// Defect: a connector without the declaration gets a writable host directory.
test("a connector that does not declare BLOB gets no spool directory", async (t) => {
  const manifest = blobManifest({ capabilities: undefined, protocol_capabilities: undefined });
  const { ownerToken, server } = await setup(t, manifest);
  const outcome = await runSteps(server, ownerToken, manifest, [
    emit({
      data: { id: "plain" },
      emitted_at: RECORD_AT,
      key: "plain",
      stream: OTHER_STREAM,
      type: "RECORD",
    }),
    emit(DONE(1)),
  ]);
  assert.equal(outcome.thrown, null, failureOf(outcome));
  assert.equal(outcome.result?.status, "succeeded");
  assert.equal(outcome.spoolDir, null);
});

// Behavior: a BLOB from a connector that declares BLOB but no usable
// host_blob_write fails closed; so does a BLOB for a stream outside it.
// Defect: the runtime accepts a write that the manifest never authorised.
test("a BLOB without a usable host_blob_write declaration, or outside its streams, fails closed", async (t) => {
  const ids = contentFor("undeclared");
  const cases: [string, Record<string, unknown>, Step[], RegExp][] = [
    [
      "no host_blob_write",
      blobManifest({ capabilities: undefined }),
      goodSequence(ids),
      /without declaring BLOB and capabilities\.host_blob_write/,
    ],
    [
      "stream outside host_blob_write.streams",
      blobManifest(),
      [
        { file: `${ids.key}.json`, op: "write", text: ids.text },
        emit(blobMessage(ids, { stream: OTHER_STREAM })),
        emit(recordMessage(ids, {}, OTHER_STREAM)),
      ],
      /outside host_blob_write\.streams/,
    ],
  ];
  for (const [label, manifest, steps, pattern] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own server.
    const { ownerToken, server } = await setup(t, manifest);
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const outcome = await runSteps(server, ownerToken, manifest, [...steps, emit(DONE(1))]);
    assert.match(failureOf(outcome), pattern, label);
    const stream = label.startsWith("stream") ? OTHER_STREAM : STREAM;
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated read.
    const records = await storedRecords(server, ownerToken, manifest, stream);
    assert.equal(
      records.some((r) => r.data.id === ids.key),
      false,
      `${label}: nothing is stored`
    );
  }
});

// Behavior: a BLOB whose spool file does not match its descriptor, or that
// breaks a bound, fails the run before anything is stored.
// Defect: unverified bytes reach the blob store (wrong hash, wrong size, over
// the cap, not JSON, a symlink read through to another file, a missing file).
// Oracle: the run fails with the named reason; the record and its blob are absent.
test("an oversized or malformed BLOB fails closed and stores nothing", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);

  const make = (key: string, text?: string): Ids => {
    const base = contentFor(key);
    if (text === undefined) {
      return base;
    }
    return { ...base, sha256: createHash("sha256").update(text).digest("hex"), size: Buffer.byteLength(text), text };
  };
  const big = make("oversized", JSON.stringify({ pad: "x".repeat(MAX_BLOB_BYTES) }));
  const notJson = make("not-json", "not json at all");
  const wrongHash = contentFor("wrong-hash");
  const wrongSize = contentFor("wrong-size");
  const linked = contentFor("symlinked");
  const missing = contentFor("missing-file");

  const cases: [Ids, Step[], RegExp][] = [
    [big, [writeStep(big), emit(blobMessage(big)), emit(recordMessage(big))], /exceeds the declared max_blob_bytes/],
    [
      notJson,
      [writeStep(notJson), emit(blobMessage(notJson)), emit(recordMessage(notJson))],
      /is not valid UTF-8 JSON/,
    ],
    [
      wrongHash,
      [writeStep(wrongHash), emit(blobMessage(wrongHash, { sha256: "0".repeat(64) })), emit(recordMessage(wrongHash))],
      /does not match its sha256/,
    ],
    [
      wrongSize,
      [writeStep(wrongSize), emit(blobMessage(wrongSize, { size_bytes: wrongSize.size + 1 })), emit(recordMessage(wrongSize))],
      /does not match its spool file size/,
    ],
    [
      linked,
      [
        { file: `${linked.key}.json`, op: "symlink", target: "/etc/hostname" },
        emit(blobMessage(linked)),
        emit(recordMessage(linked)),
      ],
      /spool file that cannot be read/,
    ],
    [missing, [emit(blobMessage(missing)), emit(recordMessage(missing))], /spool file that cannot be read/],
  ];
  for (const [ids, steps, pattern] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const outcome = await runSteps(server, ownerToken, manifest, [...steps, emit(DONE(1))]);
    assert.match(failureOf(outcome), pattern, ids.key);
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated read.
    const records = await storedRecords(server, ownerToken, manifest);
    assert.equal(
      records.some((r) => r.data.id === ids.key),
      false,
      `${ids.key}: no record is stored`
    );
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated read.
    const blob = await fetchBlob(server, ownerToken, manifest, `blob_sha256_${ids.sha256}`);
    assert.equal(blob.status, 404, `${ids.key}: no blob is stored`);
  }
});

// Behavior: a path that leaves the spool is refused by the protocol check.
// Defect: `../` reads a file outside the run's directory.
test("a BLOB that names a path outside the spool fails closed", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);
  const ids = contentFor("escape");
  for (const file of ["../escape.json", "/etc/hostname", "sub/dir.json"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const outcome = await runSteps(server, ownerToken, manifest, [
      emit(blobMessage(ids, { file })),
      emit(recordMessage(ids)),
      emit(DONE(1)),
    ]);
    assert.ok(outcome.thrown instanceof Error || outcome.result?.status !== "succeeded", `${file} fails the run`);
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated read.
    const records = await storedRecords(server, ownerToken, manifest);
    assert.equal(
      records.some((r) => r.data.id === ids.key),
      false,
      `${file}: nothing is stored`
    );
  }
});

// Behavior: a RECORD that references a host blob with no BLOB before it, or
// with a BLOB for a different key or ref, fails the run (the spec's
// "dangling reference" case: a record never points at a blob the RS lacks).
// Defect: the record is stored with a ref no one can serve.
test("a RECORD with a missing or mismatched blob fails the run and is not stored", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);

  const missing = contentFor("no-blob");
  const other = contentFor("other-key");
  const refMismatch = contentFor("ref-mismatch");
  const cases: [Ids, Step[], RegExp][] = [
    [missing, [emit(recordMessage(missing))], /references a host blob but no BLOB/],
    [
      other,
      [writeStep(other), emit(blobMessage(other)), emit({ ...recordMessage(other), key: "different-key" })],
      /does not match the BLOB before it/,
    ],
    [
      refMismatch,
      [writeStep(refMismatch), emit(blobMessage(refMismatch)), emit(recordMessage(refMismatch, { sha256: "1".repeat(64) }))],
      /blob_ref does not match the BLOB/,
    ],
    [
      contentFor("blob-for-plain-record"),
      [
        writeStep(contentFor("blob-for-plain-record")),
        emit(blobMessage(contentFor("blob-for-plain-record"))),
        emit({
          data: { id: "blob-for-plain-record" },
          emitted_at: RECORD_AT,
          key: "blob-for-plain-record",
          stream: STREAM,
          type: "RECORD",
        }),
      ],
      /RECORD does not reference a host blob/,
    ],
  ];
  for (const [ids, steps, pattern] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const outcome = await runSteps(server, ownerToken, manifest, [...steps, emit(DONE(1))]);
    assert.match(failureOf(outcome), pattern, ids.key);
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated read.
    const records = await storedRecords(server, ownerToken, manifest);
    assert.equal(
      records.some((r) => r.data.id === ids.key),
      false,
      `${ids.key}: no record is stored`
    );
  }
});

// Behavior: while a BLOB waits for its RECORD, only PROGRESS may arrive. A
// second BLOB, a STATE or a DONE fails the run.
// Defect: a STATE or DONE commits a run that holds a blob with no record.
test("a second BLOB, STATE or DONE between a BLOB and its RECORD fails the run", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);
  const first = contentFor("held-first");
  const second = contentFor("held-second");
  const cases: [string, Step[], RegExp][] = [
    [
      "second BLOB",
      [writeStep(first), writeStep(second), emit(blobMessage(first)), emit(blobMessage(second))],
      /second BLOB before the RECORD/,
    ],
    [
      "STATE",
      [writeStep(first), emit(blobMessage(first)), emit({ cursor: { page: "1" }, stream: STREAM, type: "STATE" })],
      /STATE between a BLOB and its RECORD/,
    ],
    [
      "DONE",
      [writeStep(first), emit(blobMessage(first)), emit(DONE(0))],
      /DONE between a BLOB and its RECORD/,
    ],
  ];
  for (const [label, steps, pattern] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const outcome = await runSteps(server, ownerToken, manifest, steps);
    assert.match(failureOf(outcome), pattern, label);
  }
  const records = await storedRecords(server, ownerToken, manifest);
  assert.equal(records.length, 0, "nothing is stored by any of the failed runs");
  const blob = await fetchBlob(server, ownerToken, manifest, `blob_sha256_${first.sha256}`);
  assert.equal(blob.status, 404, "the held blob never reached the store");
});

// Behavior: the connector exits between BLOB and RECORD (the same path a
// cancel takes). The run fails, nothing is stored, the spool is removed.
// Defect: a held blob is stored without its record, or the spool leaks.
test("a connector that ends between a BLOB and its RECORD stores nothing and leaves no spool", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);
  const ids = contentFor("cut-short");
  const outcome = await runSteps(server, ownerToken, manifest, [writeStep(ids), emit(blobMessage(ids))]);
  assert.ok(outcome.thrown instanceof Error || outcome.result?.status !== "succeeded", "the run does not succeed");
  const records = await storedRecords(server, ownerToken, manifest);
  assert.equal(records.length, 0);
  const blob = await fetchBlob(server, ownerToken, manifest, `blob_sha256_${ids.sha256}`);
  assert.equal(blob.status, 404, "the held blob never reached the store");
  assert.ok(outcome.spoolDir);
  assert.equal(existsSync(outcome.spoolDir as string), false, "the spool directory is removed");
});

// Behavior: a blob upload the RS refuses, or answers with a different hash,
// fails the run before the record is buffered. The record is not stored.
// Defect: the record is accepted with a ref to a blob the RS never kept (the
// dangling reference the model's NoDanglingReference invariant forbids).
// Oracle: the run fails with the upload reason and the owner reads no record.
// A stub for the RS answer is needed: a real RS accepts a valid upload, so a
// refusal or a wrong hash cannot be produced through the real route.
test("a refused or tampered blob upload fails the run and the record is not stored", async (t) => {
  const manifest = blobManifest();
  const { ownerToken, server } = await setup(t, manifest);
  const cases: [string, (ids: Ids) => Response, RegExp][] = [
    ["refused", () => new Response("{}", { status: 400 }), /Blob upload for attachments failed/],
    [
      "wrong hash",
      () => Response.json({ blob_id: `blob_sha256_${"2".repeat(64)}`, sha256: "2".repeat(64), size_bytes: 1 }),
      /does not match the connector's BLOB/,
    ],
    // Hash and size match, so only the id check can catch it.
    [
      "wrong id",
      (ids) => Response.json({ blob_id: `blob_sha256_${"3".repeat(64)}`, sha256: ids.sha256, size_bytes: ids.size }),
      /does not match the connector's BLOB/,
    ],
  ];
  for (const [label, answer, pattern] of cases) {
    const ids = contentFor(`upload-${label.replace(" ", "-")}`);
    const realFetch = globalThis.fetch;
    const stub = t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).includes("/v1/blobs") && init?.method === "POST" ? Promise.resolve(answer(ids)) : realFetch(input, init)
    );
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated run.
    const outcome = await runSteps(server, ownerToken, manifest, [...goodSequence(ids), emit(DONE(1))]);
    stub.mock.restore();
    assert.match(failureOf(outcome), pattern, label);
    // biome-ignore lint/performance/noAwaitInLoops: each case is one isolated read.
    const records = await storedRecords(server, ownerToken, manifest);
    assert.equal(
      records.some((r) => r.data.id === ids.key),
      false,
      `${label}: no record is stored`
    );
  }
});
