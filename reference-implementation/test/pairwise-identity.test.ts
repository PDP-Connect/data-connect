// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCoreSelection } from "../server/core-source-authorization.ts";
import { closeDb, initDb } from "../server/db.ts";
import { getPairwiseHandle, projectPairwiseGrant, resolvePairwiseInstanceHandle } from "../server/pairwise-identity.ts";

test("pairwise identifiers persist, differ by client, and bind instance across streams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-pairwise-"));
  const path = join(dir, "identity.sqlite");
  const prior = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  try {
    initDb(path);
    const grant = {
      client: { client_id: "client-a" },
      grantors: [{ capacity: "guardian", id: "representative" }],
      source: { id: "source-a" },
      streams: [
        { instance_ids: ["internal-account"], name: "one" },
        { instance_ids: ["internal-account"], name: "two" },
      ],
      subject: { id: "owner" },
    };
    const first = await projectPairwiseGrant(grant);
    assert.notEqual(first.subject.id, "owner");
    assert.notEqual(first.grantors[0]!.id, "representative");
    assert.match(first.streams[0]!.instance_ids[0]!, /^inst_/);
    assert.equal(first.streams[0]!.instance_ids[0]!, first.streams[1]!.instance_ids[0]!);
    assert.deepEqual(grant.streams[0]!.instance_ids, ["internal-account"]);
    const second = await projectPairwiseGrant({
      ...grant,
      client: { client_id: "client-b" },
    });
    assert.notEqual(first.subject.id, second.subject.id);
    assert.notEqual(first.grantors[0]!.id, second.grantors[0]!.id);
    const otherSubject = await projectPairwiseGrant({
      ...grant,
      subject: { id: "another-owner" },
    });
    assert.equal(first.grantors[0]!.id, otherSubject.grantors[0]!.id);
    assert.notEqual(first.streams[0]!.instance_ids[0]!, second.streams[0]!.instance_ids[0]!);
    assert.equal(
      await resolvePairwiseInstanceHandle({
        clientId: "client-a",
        handle: second.streams[0]!.instance_ids[0]!,
        sourceId: "source-a",
        subjectId: "owner",
      }),
      null
    );
    closeDb();
    initDb(path);
    assert.deepEqual(await projectPairwiseGrant(grant), first);
    assert.equal(
      await resolvePairwiseInstanceHandle({
        clientId: "client-a",
        handle: first.streams[0]!.instance_ids[0]!,
        sourceId: "source-a",
        subjectId: "owner",
      }),
      "internal-account"
    );
    process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "0";
    assert.deepEqual(await projectPairwiseGrant(grant), grant);
  } finally {
    closeDb();
    if (prior === undefined) {
      delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
    } else {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = prior;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("concurrent handle issuance never reassigns an identity", async () => {
  initDb();
  try {
    const handles = await Promise.all(
      Array.from({ length: 20 }, () =>
        getPairwiseHandle({
          clientId: "a",
          internalId: "owner",
          kind: "subject",
          subjectId: "owner",
        })
      )
    );
    assert.equal(new Set(handles).size, 1);
  } finally {
    closeDb();
  }
});

test("pairwise resource selections reject multiple instances before approval", () => {
  const declaration = JSON.parse(
    readFileSync(new URL("./seam-spike/fixtures/pr89/source.json", import.meta.url), "utf8")
  );
  const selection = {
    streams: [
      {
        fields: ["id"],
        instance_ids: ["inst_a", "inst_b"],
        name: "top_artists",
        resources: ["artist:42"],
      },
    ],
  };
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  try {
    assert.throws(() => resolveCoreSelection(selection, declaration), /resources must cover exactly one instance/);
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
  assert.equal(resolveCoreSelection(selection, declaration).length, 1);
});
