// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  DatasetSummary,
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  TraceSummary,
} from "../../lib/ref-client.ts";
import { sourceStatusWords } from "../../lib/source-status-words.ts";
import { buildDemoInputs, type DemoScenario } from "./standing-demo-data.ts";
import {
  buildHomeViewModel,
  grantReads,
  type HomeHrefs,
  type HomeInputs,
  joinHuman,
  scopeHuman,
} from "./standing-view-model.ts";

const NOW = new Date("2026-11-24T12:00:00Z");
const SUCCESS = "2026-11-24T10:00:00.000Z";

const HREFS: HomeHrefs = {
  addSource: "/sources/add",
  connect: "/connect",
  deployment: "/deployment",
  deploymentTokens: "/deployment/tokens",
  grant: (id) => `/grants/${id}`,
  grants: "/grants",
  packages: "/grants/packages",
  source: (id) => `/sources/${id}`,
  sources: "/sources",
};

function health(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: {
      attention: "none",
      coverage: "complete",
      freshness: "fresh",
      outbox: "idle",
    },
    badges: { stale: false, syncing: false },
    last_success_at: SUCCESS,
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state: "healthy",
    unknown_reasons: [],
    ...overrides,
  };
}

function requiredAction(overrides: Partial<RefRequiredAction> = {}): RefRequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Finish this step",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    surface: { kind: "provider_interaction" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

function verdict(
  label: RefRenderedVerdict["pill"]["label"] = "Healthy",
  actions: RefRequiredAction[] = [],
): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "The source is ready.",
    pill: {
      label,
      tone: label === "Healthy" || label === "Import complete" ? "green" : "amber",
    },
    progress: {
      gaps_drained_last_run: null,
      headline: "Current status.",
      last_refreshed_at: null,
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: actions,
    streams: [],
    trace: {},
  };
}

const HEALTHY_STATE = {
  evidence_as_of: SUCCESS,
  owner_of_state: "system" as const,
  posture: "observed" as const,
  resolver: "healthy" as const,
};

function statusSource(row: number, name: string, overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  const sourceId = `source-${row}-${name.toLowerCase().replaceAll(" ", "-")}`;
  const base: RefConnectorSummary = {
    connection_health: health(),
    connection_id: sourceId,
    connector_id: name.toLowerCase().replaceAll(" ", "-"),
    display_name: name,
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    owner_state: HEALTHY_STATE,
    rendered_verdict: verdict(),
    schedule: null,
    streams: [],
    total_records: 20,
  };
  const successfulRun = {
    event_count: 4,
    failure_reason: null,
    finished_at: SUCCESS,
    first_at: SUCCESS,
    last_at: SUCCESS,
    needs_input: false,
    object: "run_summary" as const,
    provider_id: null,
    run_id: `run-${sourceId}`,
    started_at: SUCCESS,
    status: "succeeded",
  };

  switch (row) {
    case 1:
      return {
        ...base,
        source_visibility: "archived",
        status: "paused",
        ...overrides,
      };
    case 2:
      return {
        ...base,
        revoked_at: SUCCESS,
        source_visibility: "setup_failed",
        ...overrides,
      };
    case 3:
      return {
        ...base,
        connector_implementation: {
          connector_id: base.connector_id,
          state: "not_installed",
        },
        status: "revoked",
        ...overrides,
      };
    case 4:
      return {
        ...base,
        connector_implementation: {
          connector_id: base.connector_id,
          state: "not_installed",
        },
        ...overrides,
      };
    case 5:
      return {
        ...base,
        terminal_setup_disposition: "unverified_missing_counts",
        ...overrides,
      };
    case 6:
      return {
        ...base,
        terminal_setup_disposition: "unverified_zero",
        ...overrides,
      };
    case 7:
      return {
        ...base,
        terminal_setup_disposition: "verified_empty",
        ...overrides,
      };
    case 8:
      return {
        ...base,
        owner_state: {
          ...HEALTHY_STATE,
          owner_of_state: "owner",
          resolver: "needs_owner",
        },
        rendered_verdict: verdict("Can't collect", [requiredAction()]),
        ...overrides,
      };
    case 9:
      return {
        ...base,
        owner_state: {
          ...HEALTHY_STATE,
          owner_of_state: "owner",
          resolver: "setup_in_progress",
        },
        ...overrides,
      };
    case 10:
      return {
        ...base,
        owner_state: {
          ...HEALTHY_STATE,
          owner_of_state: "owner",
          resolver: "owner_paused",
        },
        status: "paused",
        ...overrides,
      };
    case 11:
      return {
        ...base,
        last_run: { ...successfulRun, finished_at: null, status: "started" },
        owner_state: { ...HEALTHY_STATE, resolver: "collecting" },
        ...overrides,
      };
    case 18:
      return {
        ...base,
        owner_state: { ...HEALTHY_STATE, resolver: "healthy" },
        rendered_verdict: verdict("Import complete"),
        ...overrides,
      };
    case 19:
      return {
        ...base,
        connection_health: health({ lateness: { state: "on_time" } }),
        ...overrides,
      };
    case 20:
      return {
        ...base,
        owner_state: { ...HEALTHY_STATE, posture: "frozen-since-last-run" },
        ...overrides,
      };
    case 21:
      return {
        ...base,
        last_successful_run: successfulRun,
        owner_state: { ...HEALTHY_STATE, resolver: "not_measured" },
        rendered_verdict: verdict("Collected, not independently checked"),
        ...overrides,
      };
    case 22:
      return {
        ...base,
        connection_health: health({ last_success_at: null }),
        last_successful_run: null,
        owner_state: { ...HEALTHY_STATE, resolver: "not_measured" },
        source_kind: "account",
        ...overrides,
      };
    case 23:
      return {
        ...base,
        owner_state: undefined,
        rendered_verdict: verdict("Healthy"),
        ...overrides,
      };
    default:
      return {
        ...base,
        connection_health: health({ last_success_at: null }),
        owner_state: undefined,
        rendered_verdict: null,
        status: undefined,
        source_visibility: undefined,
        ...overrides,
      };
  }
}

const SUMMARY: DatasetSummary = {
  blob_bytes: 0,
  connector_count: 4,
  earliest_ingested_at: null,
  earliest_record_time: null,
  latest_ingested_at: null,
  latest_record_time: null,
  object: "dataset_summary",
  projection: { state: "fresh" },
  record_changes_json_bytes: 0,
  record_count: 48_120,
  record_json_bytes: 0,
  stream_count: 8,
  top_connectors: [],
  total_retained_bytes: 0,
};

function base(overrides: Partial<HomeInputs> = {}): HomeInputs {
  return {
    approvals: [],
    approvalsFailed: false,
    approvalsHaveMore: false,
    grants: [],
    grantsFailed: false,
    grantsHaveMore: false,
    hrefs: HREFS,
    now: NOW,
    ownerClients: [],
    ownerClientsFailed: false,
    ownerClientsHaveMore: false,
    reloadHref: "/?demo=calm",
    sourcePage: { hasMore: false, kind: "ok", sources: [] },
    summary: SUMMARY,
    summaryFailed: false,
    traces: [],
    tracesFailed: false,
    tracesHaveMore: false,
    ...overrides,
  };
}

function approval(id: string, clientId: string, createdAt: string): PendingApproval {
  return {
    approval_id: id,
    batch: false,
    client_id: clientId,
    created_at: createdAt,
    grant_preview: {
      streams: [{ name: "pay_statements" }, { name: "transactions" }],
    },
    kind: "consent",
    object: "approval",
  };
}

function grant(id: string, clientId: string, kinds: string[] = ["transactions"]): GrantSummary {
  return {
    client: {
      client_id: clientId,
      client_name: clientId,
      registration_mode: "dynamic",
    },
    client_id: clientId,
    connector_id: "plaid",
    event_count: 1,
    failure: null,
    first_at: SUCCESS,
    grant_id: id,
    kinds,
    last_at: SUCCESS,
    object: "grant_summary",
    status: "active",
  };
}

function trace(
  clientId: string,
  status = "succeeded",
  lastAt = SUCCESS,
  failure: TraceSummary["failure"] = null,
): TraceSummary {
  return {
    actor_id: clientId,
    actor_type: "client",
    client_id: clientId,
    event_count: 3,
    failure,
    first_at: lastAt,
    grant_id: null,
    kinds: ["transactions"],
    last_at: lastAt,
    object: "trace_summary",
    request_id: null,
    run_id: null,
    status,
    trace_id: `trace-${clientId}-${status}`,
  };
}

test("scope labels reuse the existing human mapping", () => {
  // DIRECTION.md, Home: app rows use the established plain words for permissions.
  assert.equal(scopeHuman("pay_statements.read"), "your pay");
  // DIRECTION.md, Home: unknown permission names keep a readable spaced fallback.
  assert.equal(scopeHuman("loyalty_points.read"), "loyalty points");
  // DIRECTION.md, Home: permission phrases remain complete when joined.
  assert.equal(joinHuman(["your pay", "your spending", "your email"]), "your pay, your spending, and your email");
  // DIRECTION.md, Home: apps say what they may read in plain words.
  assert.equal(
    grantReads(grant("one", "app", ["pay_statements", "transactions"])),
    "reads only your pay and your spending",
  );
  // PAGE-RULES 6 (DIRECTION.md, "What must stay true" 3): no "grant" on screen, even for consent-decision permissions.
  assert.equal(scopeHuman("consent.approved"), "access decisions");
});

test("the title answers first run, one or many needs, sync, current data, and a neutral state", () => {
  // DIRECTION.md, Home § First run: no configured data sources gets its own title.
  assert.equal(buildHomeViewModel(base()).title, "Start with one data source");

  // DIRECTION.md, Home § Needs you: the title count is the number of visible rows.
  const oneNeed = buildHomeViewModel(base({ approvals: [approval("a1", "Atlas Mortgage", SUCCESS)] }));
  assert.equal(oneNeed.title, "1 thing needs you");
  // DIRECTION.md, Home § Needs you: multiple visible rows use a plural count.
  const multipleNeeds = buildHomeViewModel(
    base({
      approvals: [approval("a1", "Atlas Mortgage", SUCCESS)],
      sourcePage: {
        hasMore: false,
        kind: "ok",
        sources: [statusSource(4, "Amazon")],
      },
    }),
  );
  assert.equal(multipleNeeds.title, "2 things need you");

  // DIRECTION.md, Home § Title: one active sync names its data source.
  assert.equal(
    buildHomeViewModel(
      base({
        sourcePage: {
          hasMore: false,
          kind: "ok",
          sources: [statusSource(11, "Amazon")],
        },
      }),
    ).title,
    "Syncing Amazon",
  );
  // DIRECTION.md, Home § Title: multiple active syncs show their count.
  assert.equal(
    buildHomeViewModel(
      base({
        sourcePage: {
          hasMore: false,
          kind: "ok",
          sources: [statusSource(11, "Amazon"), statusSource(11, "Spotify")],
        },
      }),
    ).title,
    "Syncing 2 data sources",
  );

  // DIRECTION.md, Home § Title: rows 18 and 19 are the only all-current evidence.
  const current = [statusSource(18, "Pocket"), statusSource(19, "Spotify")];
  assert.equal(
    buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources: current } })).title,
    "Everything is up to date",
  );
  // DIRECTION.md, Home § Title: other non-action states do not claim all data is current.
  assert.equal(
    buildHomeViewModel(
      base({
        sourcePage: {
          hasMore: false,
          kind: "ok",
          sources: [statusSource(20, "Oura")],
        },
      }),
    ).title,
    "Nothing needs you",
  );
});

test("the row-22 never-synced state does not create an alarm on Home", () => {
  const neverSynced = statusSource(22, "Fitbit");
  // DIRECTION.md, Home § Title: an ordinary never-synced source does not claim an owner action.
  assert.equal(sourceStatusWords(neverSynced, { now: NOW }).needsYou, false);
  // DIRECTION.md, Home § Title: use the source status, not the server-wide alarm, for the heading.
  assert.equal(
    buildHomeViewModel(
      base({
        sourcePage: { hasMore: false, kind: "ok", sources: [neverSynced] },
      }),
    ).title,
    "Nothing needs you",
  );
});

test("the prior fleet alarm maps never-synced rows into an audit failure, while Home stays row-based", async () => {
  const fleetHealth = await readFile(
    new URL("../../../../../../../reference-implementation/server/fleet-health.ts", import.meta.url),
    "utf8",
  );
  // DIRECTION.md, Home § Server warning: active source summaries enter the server answer's assessed scope.
  assert.match(fleetHealth, /assessed\.push\(ref\)/);
  // DIRECTION.md, Home § Server warning: the server answer preserves the stream audit result in coverage_audit.
  assert.match(fleetHealth, /coverage_audit: input\.streamHealth\.status/);
  // DIRECTION.md, Home § Server warning: unobserved can produce a failing stream audit and is not owner-caused.
  assert.match(fleetHealth, /const FAIL_PRODUCING_STREAM_HEALTH_CLASSES = \[[\s\S]*?"unobserved"/);
  const ownerClasses =
    fleetHealth.match(/const OWNER_CAUSED_STREAM_HEALTH_CLASSES = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  // DIRECTION.md, Home § Server warning: unobserved is excluded from the owner-caused class set.
  assert.doesNotMatch(ownerClasses, /"unobserved"/);
  // DIRECTION.md, Home § Server warning: that system-caused fail reaches the global banner.
  assert.match(fleetHealth, /streamHealthFailIsSystemCaused\(input\.streamHealth\)/);

  const ids = ["never-synced-a", "never-synced-b"];
  const home = buildHomeViewModel(
    base({
      sourcePage: {
        hasMore: false,
        kind: "ok",
        sources: ids.map((id) => statusSource(22, id)),
      },
    }),
  );
  // DIRECTION.md, Home § Title: source rows provide the title and never-synced rows are not an alarm.
  assert.equal(home.title, "Nothing needs you");
});

test("needs-you rows contain their source or request details and follow the required order", () => {
  const oldWaiting = statusSource(8, "Calendar", {
    owner_state: {
      ...HEALTHY_STATE,
      owner_of_state: "owner",
      resolver: "needs_owner",
      evidence_as_of: "2026-11-20T12:00:00Z",
    },
    last_run: {
      event_count: 0,
      failure_reason: null,
      finished_at: null,
      first_at: "2026-11-20T12:00:00Z",
      last_at: "2026-11-20T12:00:00Z",
      run_id: "run-calendar",
      started_at: "2026-11-20T12:00:00Z",
      status: "started",
    },
  });
  const newerWaiting = statusSource(8, "Browser", {
    owner_state: {
      ...HEALTHY_STATE,
      owner_of_state: "owner",
      resolver: "needs_owner",
      evidence_as_of: "2026-11-22T12:00:00Z",
    },
  });
  const oldOther = statusSource(4, "Amazon", {
    owner_state: { ...HEALTHY_STATE, evidence_as_of: "2026-11-21T12:00:00Z" },
  });
  const newerOther = statusSource(6, "Gmail", {
    owner_state: { ...HEALTHY_STATE, evidence_as_of: "2026-11-23T12:00:00Z" },
  });
  const data = buildHomeViewModel(
    base({
      approvals: [
        approval("a2", "Northstar HR", "2026-11-23T11:00:00Z"),
        approval("a1", "Atlas Mortgage", "2026-11-23T10:00:00Z"),
      ],
      sourcePage: {
        hasMore: false,
        kind: "ok",
        sources: [newerOther, newerWaiting, oldOther, oldWaiting],
      },
    }),
  );

  // DIRECTION.md, Home § Needs you: waiting provider steps appear before approvals and other source actions.
  assert.deepEqual(
    data.needs.map((need) => need.kind),
    ["waiting_sync", "waiting_sync", "approval", "approval", "source", "source"],
  );
  // DIRECTION.md, Home § Needs you: oldest items appear first inside each kind.
  assert.deepEqual(
    data.needs.map((need) => need.name),
    ["Calendar", "Browser", "Atlas Mortgage", "Northstar HR", "Amazon", "Gmail"],
  );
  // DIRECTION.md, Home § Needs you: the title count equals the rendered box row count.
  assert.equal(data.title, `${data.needs.length} things need you`);
  // DIRECTION.md, Home § Needs you: provider-interaction rows use the sync-started detail.
  assert.match(data.needs[0]?.detail ?? "", /^Sync started /);
  // DIRECTION.md, Home § Needs you: other sources use lower-first shared status wording.
  assert.equal(data.needs.find((need) => need.name === "Amazon")?.status?.words, "needs its collector installed");
  // DIRECTION.md, Home § Needs you: approval rows use the existing review destination.
  assert.equal(data.needs.find((need) => need.kind === "approval")?.actionHref, HREFS.grants);
  // DIRECTION.md, Home § Needs you: source action links land on that source's detail page.
  assert.equal(data.needs.find((need) => need.name === "Amazon")?.actionHref, HREFS.source(oldOther.connection_id));
});

test("archived, disconnected, setup-failed and needs-you rows stay out of the data-source list", () => {
  const sources = [
    statusSource(1, "Archived"),
    statusSource(2, "Setup shell"),
    statusSource(3, "Disconnected"),
    statusSource(4, "Needs install"),
    statusSource(20, "Healthy"),
  ];
  const data = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources } }));

  // DIRECTION.md, Home § Data sources: rows 1–3 and needs-you sources remain off this list.
  assert.deepEqual(
    data.dataSources.map((row) => row.name),
    ["Healthy"],
  );
  // DIRECTION.md, Home § Data sources: visible statuses come from the shared source status function.
  assert.equal(data.dataSources[0]?.status.row, sourceStatusWords(sources[4] as RefConnectorSummary, { now: NOW }).row);
  // DIRECTION.md, Home § Data sources: source row addresses use the existing route helper.
  assert.equal(data.dataSources[0]?.href, HREFS.source((sources[4] as RefConnectorSummary).connection_id));
});

test("the data-source list puts syncing rows first, sorts by name, and shows no more than twelve", () => {
  const sources = [
    statusSource(20, "Zebra"),
    statusSource(11, "Syncing"),
    ...Array.from({ length: 12 }, (_, index) => statusSource(20, `Source ${String(index + 1).padStart(2, "0")}`)),
  ];
  const data = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources } }));

  // DIRECTION.md, Home § Data sources: the list shows at most twelve sorted rows and links to the full list.
  assert.equal(data.dataSources.length, 12);
  // DIRECTION.md, Home § Data sources: syncing sources appear before alphabetical names.
  assert.equal(data.dataSources[0]?.name, "Syncing");
  // DIRECTION.md, Home § Data sources: extra rows keep a full-list link.
  assert.equal(data.showMoreSources, true);
  // DIRECTION.md, Home § Data sources: the displayed count is a direct row count.
  assert.equal(data.shownSourceCount, 12);
});

test("bounded or failed source and approval reads cannot prove an all-clear", () => {
  const currentSources = [statusSource(18, "Pocket"), statusSource(19, "Spotify")];
  const paged = buildHomeViewModel(
    base({
      sourcePage: { hasMore: true, kind: "ok", sources: currentSources },
    }),
  );
  // DIRECTION.md, Home § Title: a continuation makes the title neutral.
  assert.equal(paged.title, "Data sources");
  // DIRECTION.md, Home § Data sources: the continuation is discoverable.
  assert.equal(paged.showMoreSources, true);

  const sourceFailed = buildHomeViewModel(
    base({
      sourcePage: {
        error: "private server detail",
        hasMore: false,
        kind: "error",
        sources: [],
      },
    }),
  );
  // DIRECTION.md, Home § Read failures: a failed source read cannot claim what it might have shown.
  assert.equal(sourceFailed.title, "Data sources");
  // DIRECTION.md, Home § Read failures: source failure gets a section-local error state.
  assert.equal(sourceFailed.dataSourceError, true);
  // DIRECTION.md, Home § First run: failed reads do not turn into the first-run page.
  assert.equal(sourceFailed.firstRun, false);

  const approvalFailed = buildHomeViewModel(
    base({
      approvalsFailed: true,
      sourcePage: { hasMore: false, kind: "ok", sources: currentSources },
    }),
  );
  // DIRECTION.md, Home § Read failures: a failed approval read makes the title neutral.
  assert.equal(approvalFailed.title, "Data sources");
  // DIRECTION.md, Home § Read failures: the needs-you section reports the failed read.
  assert.equal(approvalFailed.needsError, true);
});

test("summary totals stay honest when the summary is stale, unknown, or failed", () => {
  const stale = buildHomeViewModel(base({ summary: { ...SUMMARY, projection: { state: "stale" } } }));
  // DIRECTION.md, Home § Summary: stale record totals are omitted.
  assert.equal(stale.recordCount, null);
  // DIRECTION.md, Home § Server warning: stale totals show the plain status link.
  assert.equal(stale.warning, true);
  // DIRECTION.md, Home § Summary: the source count remains a direct summary field.
  assert.equal(stale.dataSourceCount, String(SUMMARY.connector_count));

  const unknown = buildHomeViewModel(base({ summary: { ...SUMMARY, projection: undefined } }));
  // DIRECTION.md, Home § Summary: unknown summary state does not prove a current record total.
  assert.equal(unknown.recordCount, null);

  // DIRECTION.md, Home: "N data sources · N records" under the title, counted words in the singular for one.
  assert.equal(buildHomeViewModel(base()).subtitle, "4 data sources · 48,120 records");
  assert.equal(
    buildHomeViewModel(base({ summary: { ...SUMMARY, connector_count: 1, record_count: 1 } })).subtitle,
    "1 data source · 1 record",
  );
  // DIRECTION.md, Home: "Leave out the record total when the server marks it stale or unknown."
  assert.equal(stale.subtitle, "4 data sources");
  assert.equal(unknown.subtitle, "4 data sources");

  const failed = buildHomeViewModel(base({ summary: null, summaryFailed: true }));
  // DIRECTION.md, Home § Read failures: a failed summary has a local retry state.
  assert.equal(failed.summaryError, true);
});

test("apps group active grants, say what can be read, and include only matching successful recent reads", () => {
  const clients: OwnerIssuedClient[] = [
    {
      active_token_count: 1,
      client_id: "Atlas",
      client_name: "Atlas",
      created_at: SUCCESS,
    },
  ];
  const data = buildHomeViewModel(
    base({
      grants: [
        grant("g1", "Atlas", ["pay_statements"]),
        grant("g2", "Atlas", ["transactions"]),
        { ...grant("revoked", "Retired"), status: "revoked" },
      ],
      ownerClients: clients,
      traces: [
        trace("Atlas", "denied", "2026-11-24T11:45:00Z", {
          event_type: "trace.denied",
          reason: "not allowed",
        }),
        trace("Atlas", "succeeded", "2026-11-24T10:00:00Z"),
        trace("Other app", "succeeded", "2026-11-24T11:00:00Z"),
      ],
    }),
  );

  // DIRECTION.md, Home § Apps: a client with multiple active permissions gets one row.
  assert.equal(data.apps.length, 1);
  // DIRECTION.md, Home § Apps: app access reuses the permission-to-words mapping.
  assert.equal(data.apps[0]?.reads, "your pay and your spending");
  // DIRECTION.md, Home § Apps: grouped grants use the full access list address.
  assert.equal(data.apps[0]?.href, HREFS.grants);
  // DIRECTION.md, Home § Apps: only a successful read by the same app supplies last-read text.
  assert.match(data.apps[0]?.lastRead ?? "", /ago|today|yesterday/);
  // DIRECTION.md, Home § Apps: token rows count active owner-made tokens directly.
  assert.equal(data.activeTokenCount, 1);
});

test("single app links, token links, and empty-state conditions are exact", () => {
  const singleGrant = buildHomeViewModel(base({ grants: [grant("g1", "Atlas")] }));
  // DIRECTION.md, Home § Apps: one permission uses the matching access page.
  assert.equal(singleGrant.apps[0]?.href, HREFS.grant("g1"));

  const withTokens = buildHomeViewModel(
    base({
      ownerClients: [
        {
          active_token_count: 2,
          client_id: "owner",
          client_name: "Owner tool",
          created_at: SUCCESS,
        },
      ],
    }),
  );
  // DIRECTION.md, Home § Apps: access tokens have their own management address.
  assert.equal(withTokens.tokensHref, HREFS.deploymentTokens);
  // DIRECTION.md, Home § Apps: an active owner token prevents the no-app empty state.
  assert.equal(withTokens.appsEmpty, false);

  const empty = buildHomeViewModel(base());
  // DIRECTION.md, Home § Apps: the no-app message appears only when both access reads are complete.
  assert.equal(empty.appsEmpty, true);
  // DIRECTION.md, Home § Apps: keep app-access destinations in the Apps section.
  assert.equal(empty.packagesHref, HREFS.packages);
  const grantsIncomplete = buildHomeViewModel(base({ grantsHaveMore: true }));
  // DIRECTION.md, Home § Apps: incomplete permission data cannot claim no app has access.
  assert.equal(grantsIncomplete.appsEmpty, false);
  const ownerClientsFailed = buildHomeViewModel(base({ ownerClientsFailed: true }));
  // DIRECTION.md, Home § Apps: a failed token read cannot claim no app has access.
  assert.equal(ownerClientsFailed.appsEmpty, false);
  // DIRECTION.md, Home § Read failures: affected app data carries a retry state.
  assert.equal(ownerClientsFailed.appError, true);
});

test("the apps section links to all apps at twelve permissions and suppresses false empty states", () => {
  const twelveGrants = Array.from({ length: 12 }, (_, index) => grant(`grant-${index}`, `App ${index}`));
  const exactLimit = buildHomeViewModel(base({ grants: twelveGrants }));
  // DIRECTION.md, Home § Apps: reaching the permissions limit adds the all-apps link.
  assert.equal(exactLimit.allAppsLink, true);
  // DIRECTION.md, Home § Apps: the all-apps link points to the full permissions page.
  assert.equal(exactLimit.allAppsHref, HREFS.grants);

  const tracesFailed = buildHomeViewModel(base({ tracesFailed: true }));
  // DIRECTION.md, Home § Apps: incomplete reads suppress the no-app message.
  assert.equal(tracesFailed.appsEmpty, false);
  // DIRECTION.md, Home § Read failures: failed reads remain visible as a soft error.
  assert.equal(tracesFailed.appError, true);
});

test("the seeded demos exercise every active status row through the shared status function", () => {
  const scenarios: DemoScenario[] = ["calm", "alarm", "decide"];
  const rows = scenarios.flatMap((scenario) =>
    buildDemoInputs(scenario, HREFS).sourcePage.sources.map((source) => sourceStatusWords(source, { now: NOW }).row),
  );
  // DIRECTION.md, Home § Demo: every visible status row appears in at least one seeded scenario.
  assert.deepEqual(
    Array.from(new Set(rows)).sort((left, right) => left - right),
    Array.from({ length: 21 }, (_, index) => index + 4),
  );
});
