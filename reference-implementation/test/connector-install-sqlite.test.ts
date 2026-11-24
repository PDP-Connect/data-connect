// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Connector install over existing records on the SQLite backend. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";
import {
  GMAIL_INSTALL_DIGEST,
  gmailInstallService,
  installedGmail,
  shippedGmail,
} from "./helpers/connector-install-gmail-fixture.ts";

test("SQLite: an update that removes the last search declarations leaves no stale index rows after reconcile", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-sqlite-"));
  initDb(join(dataDir, "pdpp.sqlite"));
  configureSemanticBackend(makeStubBackend({ dimensions: 16 }));
  try {
    await registerConnector(shippedGmail, { backfillRetrievalIndexes: false });
    getDb()
      .prepare(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name,
           source_kind, source_binding_key, created_at, updated_at)
         VALUES('cin_gmail_sqlite', 'owner', 'gmail', 'Gmail', 'account', 'cin_gmail_sqlite', ?, ?)`
      )
      .run(new Date().toISOString(), new Date().toISOString());
    const target = { connector_id: "gmail", connector_instance_id: "cin_gmail_sqlite" };
    for (let index = 0; index < 20; index += 1) {
      const id = `m-${String(index).padStart(3, "0")}`;
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      await ingestRecord(target, {
        data: { id, received_at: at, snippet: `snippet ${id}`, subject: `subject ${id}` },
        emitted_at: at,
        key: id,
        stream: "messages",
      });
      await ingestRecord(target, {
        data: { body_text: `body ${id}`, id, message_received_at: at },
        emitted_at: at,
        key: id,
        stream: "message_bodies",
      });
    }
    const repairs: Promise<unknown>[] = [];
    const install = (artifactDigest: string, manifest: Record<string, unknown>) =>
      gmailInstallService(
        dataDir,
        { onRepair: (started) => repairs.push(started) },
        { digest: artifactDigest, manifest }
      );
    await install(GMAIL_INSTALL_DIGEST, installedGmail).install("gmail", GMAIL_INSTALL_DIGEST);
    await Promise.allSettled(repairs);
    const rows = (sql: string) =>
      Number(getDb().prepare(sql).get<{ n: number }>("gmail", "messages", "message_bodies")?.n ?? 0);
    const lexical = () =>
      rows("SELECT count(*) AS n FROM lexical_search_index WHERE connector_id = ? AND stream IN (?, ?)");
    const meta = () =>
      rows("SELECT count(*) AS n FROM lexical_search_meta WHERE connector_id = ? AND stream IN (?, ?)") +
      rows("SELECT count(*) AS n FROM semantic_search_meta WHERE connector_id = ? AND stream IN (?, ?)");
    assert.ok(lexical() > 0 && meta() > 0);

    const nextDigest = `sha256:${"c".repeat(64)}`;
    const unsearchable = {
      ...installedGmail,
      streams: ((installedGmail as Record<string, unknown>).streams as Record<string, unknown>[]).map((stream) => {
        if (stream.name !== "messages" && stream.name !== "message_bodies") return stream;
        const { query: _query, ...rest } = stream;
        return rest;
      }),
      version: "9.1.0",
    };
    await install(nextDigest, unsearchable).install("gmail", nextDigest);
    await Promise.allSettled(repairs);
    assert.equal(lexical(), 0);
    assert.equal(meta(), 0);
  } finally {
    configureSemanticBackend(null);
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});
