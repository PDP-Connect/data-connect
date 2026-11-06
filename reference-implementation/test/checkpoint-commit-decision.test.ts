// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit oracle for decideCheckpointCommits: which staged STATE_STREAM cursors
 * may commit at DONE. Each test pins one rule so a mutation to it reddens on
 * its own. End-to-end coverage through runConnector lives in
 * detail-coverage-shortfall-severity, runtime-stream-collection-failed-commit
 * and stream-evidence.
 *
 * Contract: Collection Profile v0.2.0 Sections 5.6 (coverage accounting),
 * 5.7 (STREAM_EVIDENCE is diagnostic) and 5.8 (checkpoint commit).
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

/** One DETAIL_COVERAGE report, unless overridden. */
function report(overrides: Partial<CoverageReport> & { requiredKeys: string[] }): CoverageReport {
  return {
    hydratedKeys: new Set(),
    rejectedKeys: new Set(),
    stream: "details",
    ...overrides,
  };
}

/**
 * The runtime hands the decision the whole settled entry, which also carries
 * its own runtime-specific arrays (index.ts settleDetailCoverage spreads it).
 */
function withRuntimeArrays(
  coverage: CoverageReport,
  arrays: {
    emptyKeys?: ReadonlySet<string>;
    optionalSkipKeys?: ReadonlySet<string>;
    unchangedKeys?: ReadonlySet<string>;
  }
): CoverageReport {
  return { ...coverage, ...arrays };
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

const SHORTFALL_ONE_KEY = {
  kind: "coverage_shortfall",
  missingKeyCount: 1,
  requiredKeyCount: 1,
  stateStream: "orders",
  stream: "details",
} as const;

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
  assert.deepEqual(decision.withheld, [
    {
      kind: "coverage_report_missing",
      stateStream: "orders",
      stream: "details",
    },
  ]);
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

test("a hydrated declaration credits its required key with no accepted record behind it (Section 5.6)", () => {
  const decision = decideCheckpointCommits(detailInput(report({ hydratedKeys: new Set(["k"]), requiredKeys: ["k"] })));
  assert.deepEqual(decision, { commit: ["orders"], withheld: [] });
});

test("a key-set declaration retains its accepted-record proof rule when the runtime omits advertisement", () => {
  const declared = report({
    hydratedKeys: new Set(["k"]), requiredKeys: ["k"], hydratedKeysNeedEvidence: true,
  });
  assert.deepEqual(coveredRequiredKeys(declared), [], "missing evidence is not credit for a declaring connector");
  assert.deepEqual(coveredRequiredKeys({ ...declared, evidencedKeys: new Set(["other"]) }), [],
    "an unrelated accepted key cannot credit this boundary");
  assert.deepEqual(coveredRequiredKeys({ ...declared, evidencedKeys: new Set(["k"]) }), ["k"]);
  assert.deepEqual(coveredRequiredKeys({ ...declared, evidencedKeys: new Set(["k"]), rejectedKeys: new Set(["k"]) }), [],
    "rejection still invalidates the declaring connector's hydration claim");
});

test("a required key with no hydrated declaration, gap or other accounting withholds", () => {
  const decision = decideCheckpointCommits(detailInput(report({ requiredKeys: ["k"] })));
  assert.deepEqual(decision, { commit: [], withheld: [SHORTFALL_ONE_KEY] });
});

test("runtime-specific empty, unchanged and optional-skip arrays neither credit a key nor release a checkpoint", () => {
  const runtimeArrays = [
    { emptyKeys: new Set(["k"]) },
    { unchangedKeys: new Set(["k"]) },
    { optionalSkipKeys: new Set(["k"]) },
  ];
  for (const arrays of runtimeArrays) {
    const decision = decideCheckpointCommits(detailInput(withRuntimeArrays(report({ requiredKeys: ["k"] }), arrays)));
    assert.deepEqual(decision, { commit: [], withheld: [SHORTFALL_ONE_KEY] }, JSON.stringify(Object.keys(arrays)));
  }
});

test("a rejected record uncredits a hydrated key, but a durable gap for that key still covers it", () => {
  const rejected = decideCheckpointCommits(
    detailInput(
      report({
        hydratedKeys: new Set(["k"]),
        rejectedKeys: new Set(["k"]),
        requiredKeys: ["k"],
      })
    )
  );
  assert.deepEqual(rejected, { commit: [], withheld: [SHORTFALL_ONE_KEY] });

  const gapped = decideCheckpointCommits(
    detailInput(report({ rejectedKeys: new Set(["k"]), requiredKeys: ["k"] }), {
      durableGaps: [
        {
          parent_stream: "orders",
          record_key: "k",
          status: "pending",
          stream: "details",
        },
      ],
    })
  );
  assert.deepEqual(gapped.commit, ["orders"]);
});

test("coveredRequiredKeys counts hydrated keys no rejection contradicts, and nothing else", () => {
  const covered = coveredRequiredKeys(
    withRuntimeArrays(
      report({
        hydratedKeys: new Set(["h", "r"]),
        rejectedKeys: new Set(["r"]),
        requiredKeys: ["h", "r", "e", "u", "s", "g"],
      }),
      {
        emptyKeys: new Set(["e"]),
        optionalSkipKeys: new Set(["s"]),
        unchangedKeys: new Set(["u"]),
      }
    )
  );
  assert.deepEqual(covered, ["h"]);
});

test("a hydrated key and a gapped key together commit; a key with neither withholds with an exact count", () => {
  const decision = decideCheckpointCommits(
    detailInput(report({ hydratedKeys: new Set(["k"]), requiredKeys: ["k", "m"] }), {
      durableGaps: [
        {
          parent_stream: "orders",
          record_key: "m",
          status: "pending",
          stream: "details",
        },
      ],
    })
  );
  assert.deepEqual(decision, { commit: ["orders"], withheld: [] });

  const short = decideCheckpointCommits(
    detailInput(report({ hydratedKeys: new Set(["k"]), requiredKeys: ["k", "m"] }))
  );
  assert.deepEqual(short, {
    commit: [],
    withheld: [{ ...SHORTFALL_ONE_KEY, missingKeyCount: 1, requiredKeyCount: 2 }],
  });
});

test("a pending or recovered durable gap credits its key; any other status does not", () => {
  for (const [status, commits] of [
    ["pending", true],
    ["recovered", true],
    ["abandoned", false],
  ] as const) {
    const decision = decideCheckpointCommits(
      detailInput(report({ requiredKeys: ["k"] }), {
        durableGaps: [
          {
            parent_stream: "orders",
            record_key: "k",
            status,
            stream: "details",
          },
        ],
      })
    );
    assert.deepEqual(decision.commit, commits ? ["orders"] : [], `status=${status}`);
  }
});

test("a durable gap credits only the same stream and a numeric key matches its string form", () => {
  const otherStream = decideCheckpointCommits(
    detailInput(report({ requiredKeys: ["7"] }), {
      durableGaps: [
        {
          parent_stream: "orders",
          record_key: 7,
          status: "pending",
          stream: "other",
        },
      ],
    })
  );
  assert.deepEqual(otherStream.commit, []);
  const sameStream = decideCheckpointCommits(
    detailInput(report({ requiredKeys: ["7"] }), {
      durableGaps: [
        {
          parent_stream: "orders",
          record_key: 7,
          status: "pending",
          stream: "details",
        },
      ],
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
      durableGaps: [
        {
          parent_stream: "returns",
          record_key: "k",
          status: "pending",
          stream: "details",
        },
      ],
    })
  );
  assert.deepEqual(decision.commit, []);
});

test("a retryable skip withholds only the stream's own state stream", () => {
  const decision = decideCheckpointCommits(
    input({
      omissions: [{ source: "retryable_skip", stream: "b" }],
      stagedStateStreams: ["a", "b"],
    })
  );
  assert.deepEqual(decision.commit, ["a"]);
  assert.deepEqual(decision.withheld, [
    {
      kind: "reported_omission",
      source: "retryable_skip",
      stateStream: "b",
      stream: "b",
    },
  ]);
});

test("STREAM_EVIDENCE is diagnostic: a state_stream child's unaccounted outcomes never withhold its parent (Section 5.7)", () => {
  // The decision takes no STREAM_EVIDENCE input. The runtime's
  // `outcomes.unaccounted > 0` fact for `bodies` (child of `messages`) is
  // therefore absent here, and the parent commits.
  const decision = decideCheckpointCommits(
    input({
      stagedStateStreams: ["messages"],
      stateStreamByStream: new Map([["bodies", "messages"]]),
    })
  );
  assert.deepEqual(decision, { commit: ["messages"], withheld: [] });
});

test("a genuine stream_collection_failed omission on the same child still withholds its parent", () => {
  // Control for the STREAM_EVIDENCE test above: the gating path is intact.
  const decision = decideCheckpointCommits(
    input({
      omissions: [{ source: "stream_collection_failed", stream: "bodies" }],
      stagedStateStreams: ["messages"],
      stateStreamByStream: new Map([["bodies", "messages"]]),
    })
  );
  assert.deepEqual(decision, {
    commit: [],
    withheld: [
      {
        kind: "reported_omission",
        source: "stream_collection_failed",
        stateStream: "messages",
        stream: "bodies",
      },
    ],
  });
});

test("an omission on one child does not withhold an unrelated staged stream", () => {
  // Scope: `bodies` belongs to `messages` only, so `other` still commits.
  const decision = decideCheckpointCommits(
    input({
      omissions: [{ source: "stream_collection_failed", stream: "bodies" }],
      stagedStateStreams: ["messages", "other"],
      stateStreamByStream: new Map([["bodies", "messages"]]),
    })
  );
  assert.deepEqual(decision.commit, ["other"]);
  assert.deepEqual(
    decision.withheld.map((reason) => reason.kind),
    ["reported_omission"]
  );
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
    input({
      omissions: [{ source: "retryable_skip", stream: "unstaged" }],
      stagedStateStreams: ["a"],
    })
  );
  assert.deepEqual(decision, { commit: ["a"], withheld: [] });
});

test("an omission that names no stream withholds every staged state stream", () => {
  const decision = decideCheckpointCommits(
    input({
      omissions: [{ source: "retryable_skip", stream: null }],
      stagedStateStreams: ["a", "b"],
    })
  );
  assert.deepEqual(decision.commit, []);
  assert.deepEqual(decision.withheld, [
    {
      kind: "reported_omission",
      source: "retryable_skip",
      stateStream: "a",
      stream: null,
    },
    {
      kind: "reported_omission",
      source: "retryable_skip",
      stateStream: "b",
      stream: null,
    },
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
