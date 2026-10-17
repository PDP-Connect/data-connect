// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit oracle for decideCheckpointCommits: which staged STATE_STREAM cursors
 * may commit at DONE. Each test pins one rule so a mutation to it reddens on
 * its own. End-to-end coverage through runConnector lives in
 * detail-coverage-shortfall-severity, runtime-stream-collection-failed-commit
 * and stream-evidence.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type CheckpointCommitInput,
  type CoverageReport,
  coveredRequiredKeys,
  decideCheckpointCommits,
} from "../runtime/checkpoint-commit-decision.ts";
import { capCoveredCount } from "../runtime/connector-gap-bounding.ts";

function input(overrides: Partial<CheckpointCommitInput>): CheckpointCommitInput {
  return {
    coverageByStateStream: new Map(),
    detailParentsByStream: new Map(),
    durableGaps: [],
    inScopeStreams: new Set(),
    omissions: [],
    stagedStateStreams: [],
    stateStreamByStream: new Map(),
    ...overrides,
  };
}

/** A report from a connector that declares DETAIL_COVERAGE_KEY_SETS, unless overridden. */
function report(overrides: Partial<CoverageReport> & { requiredKeys: string[] }): CoverageReport {
  return {
    emptyKeys: new Set(),
    evidencedKeys: new Set(),
    hydratedKeys: new Set(),
    hydratedKeysNeedEvidence: true,
    optionalSkipKeys: new Set(),
    rejectedKeys: new Set(),
    stream: "details",
    unchangedKeys: new Set(),
    ...overrides,
  };
}

/** One parent `orders` whose detail stream `details` declares it in parent_streams. */
function detailInput(coverage: CoverageReport, extra: Partial<CheckpointCommitInput> = {}): CheckpointCommitInput {
  return input({
    coverageByStateStream: new Map([["orders", [coverage]]]),
    detailParentsByStream: new Map([["details", new Set(["orders"])]]),
    inScopeStreams: new Set(["orders", "details"]),
    stagedStateStreams: ["orders"],
    ...extra,
  });
}

test("with nothing reported, every staged state stream commits in staging order", () => {
  const decision = decideCheckpointCommits(input({ stagedStateStreams: ["b", "a", "c"] }));
  assert.deepEqual(decision, { commit: ["b", "a", "c"], withheld: [] });
});

test("an in-scope detail stream with no coverage report withholds its declared parent", () => {
  const decision = decideCheckpointCommits(
    input({
      detailParentsByStream: new Map([["details", new Set(["orders"])]]),
      inScopeStreams: new Set(["orders", "details"]),
      stagedStateStreams: ["orders", "other"],
    })
  );
  assert.deepEqual(decision.commit, ["other"]);
  assert.deepEqual(decision.withheld, [{ kind: "coverage_report_missing", stateStream: "orders", stream: "details" }]);
});

test("an out-of-scope detail stream needs no coverage report", () => {
  const decision = decideCheckpointCommits(
    input({
      detailParentsByStream: new Map([["details", new Set(["orders"])]]),
      inScopeStreams: new Set(["orders"]),
      stagedStateStreams: ["orders"],
    })
  );
  assert.deepEqual(decision.commit, ["orders"]);
});

test("a hydrated key credits its required key only with an accepted record for it", () => {
  const evidenced = decideCheckpointCommits(
    detailInput(report({ evidencedKeys: new Set(["k"]), hydratedKeys: new Set(["k"]), requiredKeys: ["k"] }))
  );
  assert.deepEqual(evidenced.commit, ["orders"]);
  const bare = decideCheckpointCommits(detailInput(report({ hydratedKeys: new Set(["k"]), requiredKeys: ["k"] })));
  assert.deepEqual(bare.commit, []);
  assert.deepEqual(bare.withheld, [
    { kind: "coverage_shortfall", missingKeyCount: 1, requiredKeyCount: 1, stateStream: "orders", stream: "details" },
  ]);
});

test("an accepted record without a hydrated declaration credits nothing", () => {
  const decision = decideCheckpointCommits(detailInput(report({ evidencedKeys: new Set(["k"]), requiredKeys: ["k"] })));
  assert.deepEqual(decision.commit, []);
});

test("verified-empty and verified-unchanged keys credit without a record", () => {
  for (const field of ["emptyKeys", "unchangedKeys"] as const) {
    const decision = decideCheckpointCommits(detailInput(report({ [field]: new Set(["k"]), requiredKeys: ["k"] })));
    assert.deepEqual(decision.commit, ["orders"], field);
  }
});

test("a rejected record uncredits every connector outcome for its key, but not a durable gap", () => {
  for (const field of ["hydratedKeys", "emptyKeys", "unchangedKeys", "optionalSkipKeys"] as const) {
    const decision = decideCheckpointCommits(
      detailInput(
        report({
          [field]: new Set(["k"]),
          evidencedKeys: new Set(["k"]),
          rejectedKeys: new Set(["k"]),
          requiredKeys: ["k"],
        })
      )
    );
    assert.deepEqual(decision.commit, [], field);
  }
  const gapped = decideCheckpointCommits(
    detailInput(report({ rejectedKeys: new Set(["k"]), requiredKeys: ["k"] }), {
      durableGaps: [{ parent_stream: "orders", record_key: "k", status: "pending", stream: "details" }],
    })
  );
  assert.deepEqual(gapped.commit, ["orders"]);
});

test("coveredRequiredKeys counts evidenced, empty and unchanged keys, never skips, gaps or rejections", () => {
  const covered = coveredRequiredKeys(
    report({
      emptyKeys: new Set(["e"]),
      evidencedKeys: new Set(["h", "bare-evidence", "r"]),
      hydratedKeys: new Set(["h", "unevidenced", "r"]),
      optionalSkipKeys: new Set(["s"]),
      rejectedKeys: new Set(["r"]),
      requiredKeys: ["h", "unevidenced", "bare-evidence", "e", "u", "s", "r", "g"],
      unchangedKeys: new Set(["u"]),
    })
  );
  assert.deepEqual(covered, ["h", "e", "u"]);
});

test("without DETAIL_COVERAGE_KEY_SETS, a bare hydrated declaration credits its key, as before the capability", () => {
  const legacy = decideCheckpointCommits(
    detailInput(report({ hydratedKeys: new Set(["k"]), hydratedKeysNeedEvidence: false, requiredKeys: ["k", "m"] }), {
      durableGaps: [{ parent_stream: "orders", record_key: "m", status: "pending", stream: "details" }],
    })
  );
  assert.deepEqual(legacy, { commit: ["orders"], withheld: [] });
  const undeclared = decideCheckpointCommits(
    detailInput(report({ hydratedKeysNeedEvidence: false, requiredKeys: ["k"] }))
  );
  assert.deepEqual(undeclared.withheld, [
    { kind: "coverage_shortfall", missingKeyCount: 1, requiredKeyCount: 1, stateStream: "orders", stream: "details" },
  ]);
});

test("without DETAIL_COVERAGE_KEY_SETS, empty and unchanged keys credit like hydrated ones and rejections still withhold", () => {
  for (const field of ["hydratedKeys", "emptyKeys", "unchangedKeys"] as const) {
    const credited = decideCheckpointCommits(
      detailInput(report({ [field]: new Set(["k"]), hydratedKeysNeedEvidence: false, requiredKeys: ["k"] }))
    );
    assert.deepEqual(credited.commit, ["orders"], field);
    const rejected = decideCheckpointCommits(
      detailInput(
        report({
          [field]: new Set(["k"]),
          hydratedKeysNeedEvidence: false,
          rejectedKeys: new Set(["k"]),
          requiredKeys: ["k"],
        })
      )
    );
    assert.deepEqual(rejected.commit, [], field);
  }
  assert.deepEqual(
    coveredRequiredKeys(
      report({
        hydratedKeys: new Set(["h", "r"]),
        hydratedKeysNeedEvidence: false,
        optionalSkipKeys: new Set(["s"]),
        rejectedKeys: new Set(["r"]),
        requiredKeys: ["h", "r", "s", "g"],
      })
    ),
    ["h"]
  );
});

test("an optional skip credits its required key", () => {
  const decision = decideCheckpointCommits(
    detailInput(report({ optionalSkipKeys: new Set(["k"]), requiredKeys: ["k"] }))
  );
  assert.deepEqual(decision.commit, ["orders"]);
});

test("a pending or recovered durable gap credits its key; any other status does not", () => {
  for (const [status, commits] of [
    ["pending", true],
    ["recovered", true],
    ["abandoned", false],
  ] as const) {
    const decision = decideCheckpointCommits(
      detailInput(report({ requiredKeys: ["k"] }), {
        durableGaps: [{ parent_stream: "orders", record_key: "k", status, stream: "details" }],
      })
    );
    assert.deepEqual(decision.commit, commits ? ["orders"] : [], `status=${status}`);
  }
});

test("a durable gap credits only the same stream and a numeric key matches its string form", () => {
  const otherStream = decideCheckpointCommits(
    detailInput(report({ requiredKeys: ["7"] }), {
      durableGaps: [{ parent_stream: "orders", record_key: 7, status: "pending", stream: "other" }],
    })
  );
  assert.deepEqual(otherStream.commit, []);
  const sameStream = decideCheckpointCommits(
    detailInput(report({ requiredKeys: ["7"] }), {
      durableGaps: [{ parent_stream: "orders", record_key: 7, status: "pending", stream: "details" }],
    })
  );
  assert.deepEqual(sameStream.commit, ["orders"]);
});

test("a parentless durable gap credits a single-parent stream but not a multi-parent one", () => {
  const gap = { record_key: "k", status: "pending", stream: "details" };
  const single = decideCheckpointCommits(detailInput(report({ requiredKeys: ["k"] }), { durableGaps: [gap] }));
  assert.deepEqual(single.commit, ["orders"]);

  const multi = decideCheckpointCommits(
    input({
      coverageByStateStream: new Map([
        ["orders", [report({ requiredKeys: ["k"] })]],
        ["returns", [report({ requiredKeys: [] })]],
      ]),
      detailParentsByStream: new Map([["details", new Set(["orders", "returns"])]]),
      durableGaps: [gap],
      inScopeStreams: new Set(["orders", "returns", "details"]),
      stagedStateStreams: ["orders", "returns"],
    })
  );
  assert.deepEqual(multi.commit, ["returns"]);
});

test("a durable gap under a different parent does not credit this parent", () => {
  const decision = decideCheckpointCommits(
    detailInput(report({ requiredKeys: ["k"] }), {
      durableGaps: [{ parent_stream: "returns", record_key: "k", status: "pending", stream: "details" }],
    })
  );
  assert.deepEqual(decision.commit, []);
});

test("a retryable skip withholds only the stream's own state stream", () => {
  const decision = decideCheckpointCommits(
    input({ omissions: [{ source: "retryable_skip", stream: "b" }], stagedStateStreams: ["a", "b"] })
  );
  assert.deepEqual(decision.commit, ["a"]);
  assert.deepEqual(decision.withheld, [
    { kind: "reported_omission", source: "retryable_skip", stateStream: "b", stream: "b" },
  ]);
});

test("unaccounted evidence on a state_stream child withholds the declared parent", () => {
  const decision = decideCheckpointCommits(
    input({
      omissions: [{ source: "unaccounted_evidence", stream: "bodies" }],
      stagedStateStreams: ["messages"],
      stateStreamByStream: new Map([["bodies", "messages"]]),
    })
  );
  assert.deepEqual(decision.commit, []);
  assert.deepEqual(decision.withheld, [
    { kind: "reported_omission", source: "unaccounted_evidence", stateStream: "messages", stream: "bodies" },
  ]);
});

test("an omission on a parent_streams child withholds every declared parent, reported or not", () => {
  const decision = decideCheckpointCommits(
    input({
      coverageByStateStream: new Map([
        ["orders", [report({ requiredKeys: [] })]],
        ["returns", [report({ requiredKeys: [] })]],
      ]),
      detailParentsByStream: new Map([["details", new Set(["orders", "returns"])]]),
      inScopeStreams: new Set(["orders", "returns", "details"]),
      omissions: [{ source: "stream_collection_failed", stream: "details" }],
      stagedStateStreams: ["orders", "returns", "other"],
    })
  );
  assert.deepEqual(decision.commit, ["other"]);
});

test("an omission on an unstaged stream withholds nothing", () => {
  const decision = decideCheckpointCommits(
    input({ omissions: [{ source: "retryable_skip", stream: "unstaged" }], stagedStateStreams: ["a"] })
  );
  assert.deepEqual(decision, { commit: ["a"], withheld: [] });
});

test("an omission that names no stream withholds every staged state stream", () => {
  const decision = decideCheckpointCommits(
    input({ omissions: [{ source: "retryable_skip", stream: null }], stagedStateStreams: ["a", "b"] })
  );
  assert.deepEqual(decision.commit, []);
  assert.deepEqual(decision.withheld, [
    { kind: "reported_omission", source: "retryable_skip", stateStream: "a", stream: null },
    { kind: "reported_omission", source: "retryable_skip", stateStream: "b", stream: null },
  ]);
});

test("reasons are grouped by staged state stream: missing reports, then shortfalls, then omissions", () => {
  const decision = decideCheckpointCommits(
    input({
      coverageByStateStream: new Map([["orders", [report({ requiredKeys: ["k"], stream: "lines" })]]]),
      detailParentsByStream: new Map([
        ["details", new Set(["orders"])],
        ["lines", new Set(["orders"])],
      ]),
      inScopeStreams: new Set(["orders", "details", "lines"]),
      omissions: [{ source: "retryable_skip", stream: "orders" }],
      stagedStateStreams: ["orders"],
    })
  );
  assert.deepEqual(
    decision.withheld.map((reason) => reason.kind),
    ["coverage_report_missing", "coverage_shortfall", "reported_omission"]
  );
});

test("capCoveredCount never raises a declared count, caps it at the provable ceiling, and keeps unknown", () => {
  assert.equal(capCoveredCount(null, 5, 1), null);
  assert.equal(capCoveredCount(2, 2, 1), 1);
  assert.equal(capCoveredCount(1, 5, 1), 1);
  assert.equal(capCoveredCount(3, 2, 5), 0);
});
