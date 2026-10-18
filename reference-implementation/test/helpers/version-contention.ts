// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Driver and oracle for the same-stream version-allocation contention tests.
 *
 * `runContention` starts N real child processes
 * (test/fixtures/crash/version-allocation-contention-child.ts). In each round
 * every child parks immediately before calling ingestRecord; the parent
 * waits until ALL are parked, then sends a resume to each. Child timestamps
 * must show at least one round where every ingest call starts before any
 * returns after commit. This proves overlapping call intervals on one stream;
 * it does not measure when SQL transactions start or lock waits occur.
 *
 * `assertContentionInvariants` is the backend-independent oracle over the
 * rows the parent reads back afterwards.
 */

import assert from "node:assert/strict";
import { join } from "node:path";

import { spawnCrashChild } from "./crash-harness.ts";

export const CONTENTION_POINT = "contention:before-ingest";
const CHILD = join(import.meta.dirname, "../fixtures/crash/version-allocation-contention-child.ts");

export interface Ack {
  readonly index: number;
  readonly key: string;
  readonly writer: string;
}

export interface ContentionResult {
  /** Writes the children reported as acknowledged. */
  readonly acks: Ack[];
  /** Per child: exit code and any rejected write it reported. */
  readonly children: {
    code: number | null;
    errors: string[];
    signal: NodeJS.Signals | null;
    stderr: string;
  }[];
  /** Successful rounds where all ingest calls started before any returned. */
  readonly overlappedRounds: number;
}

export async function runContention(options: {
  attachments?: readonly string[];
  backend: "postgres" | "sqlite";
  sqlitePath?: string;
  writers: number;
  writesPerWriter: number;
}): Promise<ContentionResult> {
  const children = Array.from({ length: options.writers }, (_, n) =>
    spawnCrashChild(CHILD, {
      args: [options.backend, options.sqlitePath ?? "-", `w${n}`, String(options.writesPerWriter)],
      env: {
        ...(options.attachments ? { CONTENTION_CHILD_ATTACHMENT: options.attachments[n] } : {}),
        // This test asserts the allocation contract, not the queueing budget:
        // a loaded host may stall one writer past the 2 s production default
        // and get a retryable `connector_instance_busy`, which is not a defect here.
        PDPP_INGEST_LOCK_WAIT_MS: "60000",
        PDPP_SQLITE_BUSY_TIMEOUT_MS: "60000",
      },
      points: [CONTENTION_POINT],
    })
  );
  try {
    for (let round = 0; round < options.writesPerWriter; round += 1) {
      await Promise.all(children.map((child) => child.parked(CONTENTION_POINT)));
      for (const child of children) child.resume();
    }
    const exits = await Promise.all(children.map((child) => child.exited));
    const acks: Ack[] = [];
    const result: ContentionResult["children"] = [];
    const timings: { committed: number; index: number; resumed: number; writer: string }[] = [];
    for (const exit of exits) {
      const errors: string[] = [];
      for (const line of exit.stdout.split("\n").filter(Boolean)) {
        const parsed = JSON.parse(line) as Ack & { committed?: number; error?: string; resumed?: number };
        if (parsed.error === undefined) {
          assert.ok(Number.isFinite(parsed.resumed), "every acknowledged write must report its resume time");
          assert.ok(Number.isFinite(parsed.committed), "every acknowledged write must report its commit time");
          timings.push({
            committed: parsed.committed as number,
            index: parsed.index,
            resumed: parsed.resumed as number,
            writer: parsed.writer,
          });
          acks.push({
            index: parsed.index,
            key: parsed.key,
            writer: parsed.writer,
          });
        } else {
          errors.push(`${parsed.writer}#${parsed.index} ${parsed.key}: ${parsed.error}`);
        }
      }
      result.push({
        code: exit.code,
        errors,
        signal: exit.signal,
        stderr: exit.stderr.slice(-2000),
      });
    }
    let overlappedRounds = 0;
    for (let round = 0; round < options.writesPerWriter; round += 1) {
      const writes = timings.filter((timing) => timing.index === round);
      if (
        new Set(writes.map((timing) => timing.writer)).size === options.writers &&
        Math.max(...writes.map((timing) => timing.resumed)) < Math.min(...writes.map((timing) => timing.committed))
      ) {
        overlappedRounds += 1;
      }
    }
    console.log(
      `[${options.backend}] overlapped rounds: ${overlappedRounds}/${options.writesPerWriter} (all ${options.writers} children resumed before any committed)`
    );
    return { acks, children: result, overlappedRounds };
  } finally {
    await Promise.all(children.map((child) => child.kill()));
  }
}

export interface ChangeRow {
  readonly data: { id: string; index: number; writer: string } | null;
  readonly record_key: string;
  readonly version: number;
}

export interface CurrentRow {
  readonly data: { id: string; index: number; writer: string } | null;
  readonly record_key: string;
  readonly version: number;
}

/**
 * The version contract under contention, as the existing sequential suite
 * states it (records-version-allocation-atomic.test.ts "changes_since
 * change-log sequence is contiguous"): every changed write takes exactly one
 * version, versions are unique and contiguous from 1, and `version_counter`
 * ends at the last one. On top of that, per stream:
 *  - every acknowledged write has its own history row carrying its payload;
 *  - one writer's acknowledged writes get strictly increasing versions
 *    (a writer never observes its later write ordered before an earlier one);
 *  - each current row equals the history row at its version.
 */
export function assertContentionInvariants(input: {
  acks: readonly Ack[];
  changes: readonly ChangeRow[];
  counter: number | null;
  current: readonly CurrentRow[];
  expectedWrites: number;
}): void {
  const { acks, changes, counter, current, expectedWrites } = input;
  assert.equal(acks.length, expectedWrites, "every write must be acknowledged");

  const versions = changes.map((row) => row.version).sort((a, b) => a - b);
  assert.equal(new Set(versions).size, versions.length, `duplicate versions in history: ${versions.join(",")}`);
  assert.deepEqual(
    versions,
    Array.from({ length: expectedWrites }, (_, n) => n + 1),
    "history versions must be contiguous 1..N, one per acknowledged changed write"
  );
  assert.equal(counter, expectedWrites, "version_counter must end at the last allocated version");

  const versionOfAck = new Map<string, number>();
  for (const ack of acks) {
    const matches = changes.filter(
      (row) => row.record_key === ack.key && row.data?.writer === ack.writer && row.data?.index === ack.index
    );
    assert.equal(matches.length, 1, `acknowledged write ${ack.writer}#${ack.index} must have exactly one history row`);
    versionOfAck.set(`${ack.writer}#${ack.index}`, (matches[0] as ChangeRow).version);
  }
  for (const writer of new Set(acks.map((ack) => ack.writer))) {
    const own = acks
      .filter((ack) => ack.writer === writer)
      .sort((a, b) => a.index - b.index)
      .map((ack) => versionOfAck.get(`${ack.writer}#${ack.index}`) as number);
    for (let n = 1; n < own.length; n += 1) {
      assert.ok(
        (own[n] as number) > (own[n - 1] as number),
        `writer ${writer} versions must strictly increase: ${own.join(",")}`
      );
    }
  }

  const byKey = new Map<string, ChangeRow[]>();
  for (const row of changes) byKey.set(row.record_key, [...(byKey.get(row.record_key) ?? []), row]);
  assert.equal(current.length, byKey.size, "one current row per key that has history");
  for (const row of current) {
    const latest = (byKey.get(row.record_key) ?? []).reduce((a, b) => (b.version > a.version ? b : a));
    assert.equal(
      row.version,
      latest.version,
      `current version of ${row.record_key} must be its latest history version`
    );
    assert.deepEqual(row.data, latest.data, `current payload of ${row.record_key} must equal its latest history row`);
  }
}
