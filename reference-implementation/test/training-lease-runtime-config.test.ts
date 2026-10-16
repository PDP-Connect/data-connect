// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-training lease prototype: runtime configuration and startup.
 *
 * - The journal must sit outside the store's backup-restore domain, so an
 *   unsafe layout is refused rather than defaulted.
 * - A training-runtime configuration failure must not leave listeners or
 *   workers running behind a rejected startServer.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startServer } from "../server/index.ts";
import {
  createTrainingLeaseRuntime,
  trainingLeaseOptionsFromEnv,
} from "../server/training-lease/runtime.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

const dirs: string[] = [];

after(() => {
  for (const d of dirs) {
    rmSync(d, { force: true, recursive: true });
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("journal location", () => {
  it("the env config requires an explicit journal directory", () => {
    const storeDir = tempDir("pdpp-lease-cfg-store-");
    assert.throws(
      () =>
        trainingLeaseOptionsFromEnv({
          PDPP_EXPERIMENTAL_AI_TRAINING_LEASES: "1",
          PDPP_TRAINING_AUTHORITY_DIR: storeDir,
        }),
      /PDPP_TRAINING_AUTHORITY_JOURNAL_DIR/,
    );
  });

  it("refuses a journal directory equal to or inside the store directory", () => {
    const storeDir = tempDir("pdpp-lease-cfg-store-");
    for (const journalDir of [storeDir, join(storeDir, "journal")]) {
      assert.throws(
        () =>
          trainingLeaseOptionsFromEnv({
            PDPP_EXPERIMENTAL_AI_TRAINING_LEASES: "1",
            PDPP_TRAINING_AUTHORITY_DIR: storeDir,
            PDPP_TRAINING_AUTHORITY_JOURNAL_DIR: journalDir,
          }),
        /outside/,
      );
      assert.throws(
        () =>
          createTrainingLeaseRuntime({
            issuer: "https://as.example",
            journalDir,
            storeDir,
          }),
        /outside/,
      );
    }
  });

  it("accepts a separate journal directory", () => {
    const storeDir = tempDir("pdpp-lease-cfg-store-");
    const journalDir = tempDir("pdpp-lease-cfg-journal-");
    const opts = trainingLeaseOptionsFromEnv({
      PDPP_EXPERIMENTAL_AI_TRAINING_LEASES: "1",
      PDPP_TRAINING_AUTHORITY_DIR: storeDir,
      PDPP_TRAINING_AUTHORITY_JOURNAL_DIR: journalDir,
    });
    assert.deepEqual(opts, { journalDir, storeDir });
    createTrainingLeaseRuntime({
      issuer: "https://as.example",
      ...(opts as { journalDir: string; storeDir: string }),
    }).close();
  });
});

function listenerCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((r) => r === "TCPServerWrap").length;
}

function timerCount(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout")
    .length;
}

/** A closed listener's handle is released asynchronously. */
async function settledListenerCount(expected: number): Promise<number> {
  for (let i = 0; i < 50 && listenerCount() !== expected; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return listenerCount();
}

const BASE_OPTS = {
  asPort: 0,
  dbPath: ":memory:",
  preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
  quiet: true,
  rsPort: 0,
  ...TEST_INTROSPECTION_SERVER_OPTS,
};

describe("startup failure", () => {
  it("the flag without PDPP_TRAINING_AUTHORITY_DIR fails startup with no listener or timer left running", async () => {
    const saved = {
      dir: process.env.PDPP_TRAINING_AUTHORITY_DIR,
      flag: process.env.PDPP_EXPERIMENTAL_AI_TRAINING_LEASES,
    };
    process.env.PDPP_EXPERIMENTAL_AI_TRAINING_LEASES = "1";
    delete process.env.PDPP_TRAINING_AUTHORITY_DIR;
    const listeners = listenerCount();
    const timers = timerCount();
    try {
      await assert.rejects(
        startServer(BASE_OPTS),
        /PDPP_TRAINING_AUTHORITY_DIR/,
      );
    } finally {
      if (saved.flag === undefined) {
        delete process.env.PDPP_EXPERIMENTAL_AI_TRAINING_LEASES;
      } else {
        process.env.PDPP_EXPERIMENTAL_AI_TRAINING_LEASES = saved.flag;
      }
      if (saved.dir !== undefined) {
        process.env.PDPP_TRAINING_AUTHORITY_DIR = saved.dir;
      }
    }
    assert.equal(await settledListenerCount(listeners), listeners);
    assert.equal(timerCount(), timers);
  });

  it("a store that fails to open fails startup with no listener or timer left running", async () => {
    const storeDir = tempDir("pdpp-lease-cfg-store-");
    const listeners = listenerCount();
    const timers = timerCount();
    await assert.rejects(
      startServer({
        ...BASE_OPTS,
        experimentalAiTrainingLeases: {
          journalDir: tempDir("pdpp-lease-cfg-journal-"),
          storeDir: join(storeDir, "missing"),
        },
      }),
    );
    assert.equal(await settledListenerCount(listeners), listeners);
    assert.equal(timerCount(), timers);
  });
});
