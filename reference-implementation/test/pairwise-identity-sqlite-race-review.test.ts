// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { getPairwiseHandle, resolvePairwiseInstanceHandle } from "../server/pairwise-identity.ts";

interface RaceWorker {
  child: ChildProcess;
  exit: Promise<number | null>;
  ready: Promise<void>;
  result: Promise<string>;
}
function spawnWorker(fixturePath: string, databasePath: string): RaceWorker {
  const env = { ...process.env };
  Reflect.deleteProperty(env, "PDPP_DATABASE_URL");
  Reflect.deleteProperty(env, "PDPP_STORAGE_BACKEND");
  const child = fork(fixturePath, [databasePath], {
    env,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  function messageOfKind(kind: "ready" | "result") {
    return new Promise<unknown>((resolve, reject) => {
      const listener = (message: unknown) => {
        if (message && typeof message === "object" && "kind" in message && message.kind === kind) {
          child.off("message", listener);
          resolve(message);
        }
      };
      child.on("message", listener);
      child.once("error", () => reject(new Error("SQLite issuance worker failed to start")));
      child.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error("SQLite issuance worker failed"));
        }
      });
    });
  }
  const ready = messageOfKind("ready").then(() => undefined);
  const result = messageOfKind("result").then((message) => {
    assert.ok(message && typeof message === "object" && "handle" in message && typeof message.handle === "string");
    return message.handle;
  });
  return { child, exit, ready, result };
}

test("two SQLite processes concurrently issue one stable handle for the same identity", {
  timeout: 30_000,
}, async () => {
  const base = join(homedir(), ".tmp");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "pdpp-pairwise-sqlite-race-"));
  const databasePath = join(directory, "identity.sqlite");
  const fixturePath = join(directory, "race-fixture.mjs");
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  const previousBackend = process.env.PDPP_STORAGE_BACKEND;
  delete process.env.PDPP_DATABASE_URL;
  delete process.env.PDPP_STORAGE_BACKEND;
  const scope = {
    clientId: "race-client",
    internalId: "race-instance",
    kind: "instance" as const,
    sourceId: "race-source",
    subjectId: "race-owner",
  };
  const workers: RaceWorker[] = [];
  try {
    // Bootstrap once before opening either independent connection.
    initDb(databasePath);
    closeDb();
    writeFileSync(
      fixturePath,
      `
import { closeDb, initDb } from ${JSON.stringify(new URL("../server/db.ts", import.meta.url).href)};
import { getPairwiseHandle } from ${JSON.stringify(new URL("../server/pairwise-identity.ts", import.meta.url).href)};
initDb(process.argv[2]);
process.once("message", async message => {
  if (message !== "go") throw new Error("Expected issuance barrier release");
  const handle = await getPairwiseHandle(${JSON.stringify(scope)});
  closeDb();
  process.send({ kind: "result", handle }, () => process.disconnect());
});
process.send({ kind: "ready" });
`
    );
    // Serialize connection initialization; only the identity INSERT/SELECT races.
    const first = spawnWorker(fixturePath, databasePath);
    workers.push(first);
    await first.ready;
    const second = spawnWorker(fixturePath, databasePath);
    workers.push(second);
    await second.ready;
    first.child.send("go");
    second.child.send("go");
    const [firstHandle, secondHandle] = await Promise.all([first.result, second.result]);
    assert.ok(firstHandle === secondHandle, "both processes must return the same persisted winner");
    assert.deepEqual(await Promise.all(workers.map((worker) => worker.exit)), [0, 0]);
    initDb(databasePath);
    const count = getDb().prepare("SELECT COUNT(*) AS count FROM pairwise_identity_handles").get<{ count: number }>();
    assert.equal(count?.count, 1, "racing issuance persists exactly one identity row");
    assert.ok((await getPairwiseHandle(scope)) === firstHandle, "later issuance retains the winning handle");
    assert.equal(await resolvePairwiseInstanceHandle({ ...scope, handle: firstHandle }), scope.internalId);
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null) {
        worker.child.kill();
      }
    }
    closeDb();
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
    if (previousBackend === undefined) {
      delete process.env.PDPP_STORAGE_BACKEND;
    } else {
      process.env.PDPP_STORAGE_BACKEND = previousBackend;
    }
    rmSync(directory, { force: true, recursive: true });
  }
});
