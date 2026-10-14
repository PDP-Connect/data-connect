// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack compatibility path for an upgraded instance.
 *
 * The OCI builder refuses slack, so it runs at the target as a developer-local
 * source keyed `slack`. The c82718d4 slack (0.6.0) stamps `data.fetched_at`;
 * data-connectors 2afb7109 (#295) removed it and moved the stream schemas to
 * 0.7.x. The path proved here: register the 0.7.1 manifest for `slack` through
 * `POST /connectors` (the same registerConnector path `/update` uses), and run
 * the 0.7.1 code as the local source. Nothing is renamed, so the key, instance
 * ids and stream names stay, and rows written under 0.6.0 stay readable.
 *
 * Fixtures: `fixtures/legacy-upgrade/slack.json` is the c82718d4 manifest,
 * `slack-0.7.1.json` is data-connectors main's `connectors/slack/manifest.json`,
 * and `slack-emitter-295/*.jsonl` are the synthetic pilot-real-shape records
 * the #295-era emitter and `schemas.ts` produce (connectors/slack/fixtures).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  fetchJson,
  legacyStoredManifest,
  type LegacyBackend,
  type LegacyUrls,
  type Row,
  snapshotOwnerRows,
  withLegacyServer,
} from "./legacy-upgrade.ts";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (options?: Record<string, unknown>) => {
  compile: (schema: object) => (value: unknown) => boolean;
};
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "legacy-upgrade");
const NOW = "2026-05-18T12:00:00.000Z";
const INSTANCE = "cin_slack_legacy";
const EMITTED_STREAMS = ["workspace", "channel_memberships", "dm_read_states", "channel_stats", "messages"] as const;

interface ManifestStream {
  readonly name: string;
  readonly primary_key: string[];
  readonly schema: Row;
}

function manifest071(): Row & { streams: ManifestStream[] } {
  return JSON.parse(readFileSync(join(FIXTURES, "slack-0.7.1.json"), "utf8"));
}

function emitted(stream: string): Row[] {
  return readFileSync(join(FIXTURES, "slack-emitter-295", `${stream}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

function schemaValidator(streams: readonly ManifestStream[]) {
  // Formats are not checked: date-time handling is not what this proves.
  const ajv = new Ajv({ strict: false, validateFormats: false });
  return (stream: string, data: Row): boolean => {
    const declared = streams.find((candidate) => candidate.name === stream);
    assert.ok(declared, `stream ${stream} is declared`);
    return ajv.compile(declared.schema)(data);
  };
}

function ownerHeaders(urls: LegacyUrls): Record<string, string> {
  return { Authorization: `Bearer ${urls.ownerToken}` };
}

function ingest(urls: LegacyUrls, stream: string, lines: readonly { data: Row; key: string }[]) {
  return fetchJson(
    `${urls.rsUrl}/v1/ingest/${stream}?connector_id=slack&connector_instance_id=${INSTANCE}`,
    {
      body: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      headers: { ...ownerHeaders(urls), "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
}

function readRecord(urls: LegacyUrls, stream: string, key: string) {
  return fetchJson(
    `${urls.rsUrl}/v1/streams/${stream}/records/${encodeURIComponent(key)}?connector_id=slack&connector_instance_id=${INSTANCE}`,
    { headers: ownerHeaders(urls) }
  );
}

async function storedStreams(backend: LegacyBackend): Promise<ManifestStream[]> {
  const [row] = await backend.query("SELECT manifest FROM connectors WHERE connector_id = 'slack'");
  assert.ok(row);
  const parsed = (typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest) as Row;
  return parsed.streams as ManifestStream[];
}

export async function assertSlackPathPreservesOwnerData(backend: LegacyBackend, databaseUrl?: string): Promise<void> {
  await withLegacyServer({ backend, databaseUrl }, async (urls) => {
    // Legacy registration, instance, state, two grant rows and two old records carrying fetched_at.
    await backend.insertConnector("slack", JSON.stringify(legacyStoredManifest("slack")));
    const store = backend.instanceStore();
    await store.upsert({
      connectorId: "slack",
      connectorInstanceId: INSTANCE,
      createdAt: NOW,
      displayName: "Legacy Slack",
      ownerSubjectId: "owner_local",
      sourceBinding: { account_hint: "legacy" },
      sourceBindingKey: "legacy",
      sourceKind: "account",
      updatedAt: NOW,
    });
    const state = await fetchJson(`${urls.rsUrl}/v1/state/slack?connector_instance_id=${INSTANCE}`, {
      body: JSON.stringify({ state: { messages: { cursor: "1714032849.000001" } } }),
      headers: { ...ownerHeaders(urls), "Content-Type": "application/json" },
      method: "PUT",
    });
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const oldWorkspace = { ...emitted("workspace")[0], fetched_at: "2026-01-01T00:00:00Z", id: "T_OLD_WORKSPACE" };
    const oldMembership = {
      channel_id: "C_OLD",
      fetched_at: "2026-01-01T00:00:00Z",
      id: "C_OLD:U_OLD",
      user_id: "U_OLD",
    };
    for (const [stream, data] of [
      ["workspace", oldWorkspace],
      ["channel_memberships", oldMembership],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: two ordered seed writes
      const seeded = await ingest(urls, stream, [{ data: data as Row, key: data.id as string }]);
      assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
      assert.equal(seeded.body.records_accepted, 1);
    }
    for (const [grantId, fields] of [
      ["grt_slack_with_fetched_at", ["id", "name", "fetched_at"]],
      ["grt_slack_without", ["id", "name"]],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: two ordered seed writes
      await backend.insertGrant(
        grantId,
        JSON.stringify({
          access_mode: "continuous",
          grant_id: grantId,
          source: { id: "slack", kind: "connector" },
          streams: [{ fields, name: "workspace" }],
        })
      );
    }
    const before = await snapshotOwnerRows(backend);
    const streamsBefore = (await storedStreams(backend)).map((stream) => stream.name);
    assert.equal(streamsBefore.length, 14);
    const oldRead = await readRecord(urls, "workspace", "T_OLD_WORKSPACE");
    assert.equal(oldRead.status, 200, JSON.stringify(oldRead.body));
    assert.equal(oldRead.body.data.fetched_at, "2026-01-01T00:00:00Z");

    // Apply the path: register the 0.7.1 manifest for the same key.
    const registered = await fetchJson(`${urls.asUrl}/connectors`, {
      body: JSON.stringify(manifest071()),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const afterRegister = await snapshotOwnerRows(backend);
    assert.deepEqual(afterRegister.connectors, before.connectors, "no second slack registration");
    assert.deepEqual(afterRegister.grants, before.grants);
    assert.deepEqual(afterRegister.records, before.records);
    assert.deepEqual(afterRegister.state, before.state);
    assert.deepEqual(
      afterRegister.instances.map((row) => ({ ...row, manifest_generation: undefined })),
      before.instances.map((row) => ({ ...row, manifest_generation: undefined }))
    );
    assert.deepEqual(
      afterRegister.instances.map((row) => row.manifest_generation),
      [String(Number(before.instances[0]?.manifest_generation) + 1)]
    );
    const streamsAfter = await storedStreams(backend);
    assert.deepEqual(
      streamsAfter.map((stream) => stream.name),
      streamsBefore,
      "same stream names in the same order"
    );
    assert.equal(
      streamsAfter.some((stream) => "fetched_at" in ((stream.schema.properties as Row) ?? {})),
      false,
      "the registered schema no longer declares fetched_at"
    );

    // Records shaped like the #295 emitter output are accepted and carry no fetched_at.
    const valid = schemaValidator(streamsAfter);
    const validOld = schemaValidator((legacyStoredManifest("slack").streams as ManifestStream[]));
    for (const stream of EMITTED_STREAMS) {
      const rows = emitted(stream);
      // biome-ignore lint/performance/noAwaitInLoops: ordered ingest per stream
      const accepted = await ingest(
        urls,
        stream,
        rows.map((data) => ({ data, key: data.id as string }))
      );
      assert.equal(accepted.status, 200, `${stream}: ${JSON.stringify(accepted.body)}`);
      assert.equal(accepted.body.records_accepted, rows.length, stream);
      for (const data of rows) {
        assert.equal("fetched_at" in data, false, `${stream} fixture carries no fetched_at`);
        assert.equal(valid(stream, data), true, `${stream} valid against the registered 0.7.1 schema`);
        assert.equal(validOld(stream, data), true, `${stream} also valid against the c82718d4 0.6.0 schema`);
        const read = await readRecord(urls, stream, data.id as string);
        assert.equal(read.status, 200, `${stream}: ${JSON.stringify(read.body)}`);
        assert.equal("fetched_at" in read.body.data, false, `${stream} stored without fetched_at`);
      }
    }

    // Old rows and grant rows are untouched by the new ingest; the old record still reads with its fetched_at.
    const afterIngest = await snapshotOwnerRows(backend);
    assert.deepEqual(afterIngest.grants, before.grants);
    assert.deepEqual(afterIngest.state, before.state);
    for (const row of before.records) {
      assert.deepEqual(
        afterIngest.records.find((candidate) => candidate.record_key === row.record_key && candidate.stream === row.stream),
        row,
        `old ${String(row.stream)} record unchanged`
      );
    }
    const oldAfter = await readRecord(urls, "workspace", "T_OLD_WORKSPACE");
    assert.equal(oldAfter.status, 200);
    assert.equal(oldAfter.body.data.fetched_at, "2026-01-01T00:00:00Z");

    // Invalid shapes the server does check are still refused: a key that disagrees with the
    // primary key (a per-record rejection), and an undeclared stream.
    const badKey = await ingest(urls, "workspace", [{ data: { id: "T_A", name: "x" }, key: "T_B" }]);
    assert.equal(badKey.status, 200, JSON.stringify(badKey.body));
    assert.equal(badKey.body.records_accepted, 0);
    assert.equal(badKey.body.rejections[0].code, "invalid_record_identity");
    const badStream = await ingest(urls, "not_a_slack_stream", [{ data: { id: "x" }, key: "x" }]);
    assert.equal(badStream.status, 404, JSON.stringify(badStream.body));
    assert.equal(badStream.body.error.code, "not_found");

    // GAP, pinned as observed: nothing on the server or in an ordinary run enforces the stream
    // schema on record data. A stale emitter (the c82718d4 code) that still stamps fetched_at is
    // accepted and stored. Keeping fetched_at out therefore depends on running the 0.7.x code as
    // the local source, not on the registered manifest. If the server starts enforcing schemas,
    // this assertion should flip and the gap is closed.
    const stale = await ingest(urls, "workspace", [
      { data: { fetched_at: "2026-10-14T00:00:00Z", id: "T_STALE", name: "stale emitter" }, key: "T_STALE" },
    ]);
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(stale.body.records_accepted, 1);
    assert.equal(valid("workspace", { fetched_at: "2026-10-14T00:00:00Z", id: "T_STALE", name: "x" }), true);
  });
}
