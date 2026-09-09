// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A protocol error — a suite that exits 0 without emitting any structured
// node-test events — is only detected while deriving counts, which happens
// after the child has already exited. The run's failure is recorded by
// coercing `observed.exit_code` to 1.
//
// The three artifacts a run leaves behind (transcript, completion, receipt)
// must agree about that coerced code. If the transcript's `end` event is
// written before the coercion, it preserves the child's raw 0 while the
// completion and receipt record 1, and the transcript — the artifact whose
// digest the other two bind — contradicts them.
//
// This exercises a REAL spawned run through `runAuthority` and reads the three
// artifacts off disk. An assertion on the ORDER OF STATEMENTS in authority.ts
// would pass against any rearrangement that still wrote a disagreeing
// transcript, so the oracle here is the artifacts themselves.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runAuthority } from "./authority.ts";
import type { Manifest } from "./inventory.ts";

type TranscriptEvent = { event: string; exit_code?: number; signal?: string | null };

/**
 * Build a throwaway git repository declaring a single suite whose command is
 * `node -e "process.exit(0)"`: it exits cleanly and emits no node-test events
 * at all, which is exactly the protocol error this gate is about.
 *
 * `command` is overridable so the passing control can declare a suite that
 * emits real structured events instead.
 */
async function fixtureRoot(command: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-authority-exit-code-order-"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "test", "noop.test.js"), "export const selected = true;\n");
  const manifest: Manifest = {
    schema: "pdpp.test-accounting/v3",
    inventory_base_sha: "0000000000000000000000000000000000000000",
    suites: [
      {
        id: "exit-code-order-fixture",
        cwd: ".",
        loader: "node-test",
        authority_argument: null,
        execution: "direct",
        command,
        profiles: [{ id: "default", required: true, skip_reasons: {} }],
        include: ["test/*.test.js"],
      },
    ],
    exclusions: [],
  };
  const writeManifest = () =>
    writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(manifest)}\n`);
  await writeManifest();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "fixture");
  // The manifest binds itself to the commit that introduced the selection, so
  // it can only be written once that commit exists.
  manifest.inventory_base_sha = git("rev-parse", "HEAD").trim();
  await writeManifest();
  git("add", "test-accounting.manifest.json");
  git("commit", "-qm", "base");
  return root;
}

/** Read the artifacts of the single run recorded under `<root>/.git/test-accounting/runs`. */
async function runArtifacts(root: string) {
  const directory = resolve(root, ".git", "test-accounting", "runs");
  const entries = await readdir(directory);
  const receiptName = entries.find((entry) => entry.endsWith(".receipt.json"));
  assert.ok(receiptName, "the run must have written a receipt");
  const runId = receiptName.slice(0, -".receipt.json".length);
  const read = async (suffix: string) => await readFile(join(directory, `${runId}${suffix}`), "utf8");
  const transcript = (await read(".transcript"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEvent);
  return {
    transcript,
    end: transcript.filter((event) => event.event === "end"),
    completion: JSON.parse(await read(".completion.json")),
    receipt: JSON.parse(await read(".receipt.json")),
  };
}

test("a protocol error is recorded as a failure by the transcript, completion and receipt alike", async () => {
  const root = await fixtureRoot([process.execPath, "-e", "process.exit(0)"]);
  try {
    // The run must be rejected for the protocol error itself. Before the
    // ordering fix it was rejected by transcript binding instead — the
    // transcript's raw 0 disagreed with the receipt's coerced 1 — which
    // reports a corrupt-looking artifact rather than the real cause.
    await assert.rejects(
      runAuthority({ root, suites: ["exit-code-order-fixture"] }),
      /exit-code-order-fixture\/default did not pass/,
      "a suite that emits no structured events must be rejected as a failing run, not as a malformed transcript"
    );

    const { end, completion, receipt } = await runArtifacts(root);

    // Exactly one end event: a duplicate would let a later, corrected event
    // mask an earlier one that still carried the raw exit code.
    assert.equal(end.length, 1, "the transcript must record exactly one end event");
    assert.equal(end[0]?.exit_code, 1, "the transcript end event must record the coerced exit code");
    assert.equal(completion.observed.exit_code, 1, "the completion must record the coerced exit code");
    assert.equal(receipt.exit_code, 1, "the receipt must record the coerced exit code");

    // The protocol error itself must be attributed, not just counted, and the
    // two records that carry counts must carry the same ones.
    assert.match(
      completion.observed.counts.protocol_error,
      /structured/,
      "the completion must attribute the protocol error"
    );
    assert.equal(
      receipt.counts.protocol_error,
      completion.observed.counts.protocol_error,
      "the receipt and completion must attribute the same protocol error"
    );
    assert.equal(receipt.counts.failed, 1, "the receipt must count the protocol error as a failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ordinary passing run still records exit 0 across all three artifacts", async () => {
  // Positive control: the reordering must not turn a clean run into a failure,
  // and must leave a genuine exit 0 intact in every artifact. This suite emits
  // one real structured pass event, so counts derive without a protocol error.
  const emit = [
    'process.stdout.write(`PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify({',
    'type: "test:pass",',
    'details: { type: "test", name: "control" },',
    "})}\\n`);",
  ].join("");
  const root = await fixtureRoot([process.execPath, "-e", emit]);
  try {
    await runAuthority({ root, suites: ["exit-code-order-fixture"] });

    const { end, completion, receipt } = await runArtifacts(root);

    assert.equal(end.length, 1, "the transcript must record exactly one end event");
    assert.equal(end[0]?.exit_code, 0, "a clean run's transcript end event must record exit 0");
    assert.equal(completion.observed.exit_code, 0, "a clean run's completion must record exit 0");
    assert.equal(receipt.exit_code, 0, "a clean run's receipt must record exit 0");
    assert.equal(receipt.counts.protocol_error, undefined, "a clean run must record no protocol error");
    assert.equal(receipt.counts.passed, 1, "the control's single passing assertion must be counted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
