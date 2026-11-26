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
    target: { kind: "sync", run_id: "run-waiting" },
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
    // Summaries carry the connector's own name; Home names rows by the shared rule.
    connector_display_name: name,
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
    appRegistrations: overrides.appRegistrations ?? (overrides.grants ?? []).map((grant) => ({
      client_id: grant.client_id || grant.grant_id, client_name: grant.client?.client_name || grant.client_id || "", return_host: "assistant.example", returns_to_this_computer: false, domain_control_verified: true, reads_last_7_days: 0,
      sources: [{ source: { kind: grant.source?.kind || "connector", id: grant.source?.id || grant.connector_id || "unknown", connector_id: grant.source?.connector_id || (grant.source ? grant.source.id : grant.connector_id) || null, connection_id: grant.source?.connection_id || null }, kinds: grant.kinds, in_force: grant.status === "active" || grant.status === "issued", first_issued_at: grant.first_at, expires_at: null, stopped_at: null, stopped_reason: null, last_read_at: grant.last_at, grant_ids: [grant.grant_id], active_grant_ids: [grant.grant_id], package_ids: [] }],
    })),
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

test("Home source labels use shared names and preserve all sources", () => {
  // DIRECTION.md, Home § Apps that can read your data: include every data source name.
  assert.equal(joinHuman(["Spotify", "GitHub", "Gmail"]), "Spotify, GitHub, and Gmail");
  // DIRECTION.md, Home § Apps that can read your data: use the named data source, not an event kind.
  assert.equal(
    grantReads({ ...grant("one", "app", ["token.issued"]), source: { id: "spotify", kind: "connector" } }),
    "reads only Spotify",
  );
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

  // DIRECTION.md, Home: one active sync names its data source.
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
  // DIRECTION.md, Home: multiple active syncs show their count.
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

  // DIRECTION.md, Home: rows 18 and 19 are the only all-current evidence.
  const current = [statusSource(18, "Pocket"), statusSource(19, "Spotify")];
  assert.equal(
    buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources: current } })).title,
    "Everything is up to date",
  );
  // DIRECTION.md, Home: other non-action states do not claim all data is current.
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
  // DIRECTION.md, Home: an ordinary never-synced source does not claim an owner action.
  assert.equal(sourceStatusWords(neverSynced, { now: NOW }).needsYou, false);
  // DIRECTION.md, Home: use the source status, not the server-wide alarm, for the heading.
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
  // DIRECTION.md, Home: active source summaries enter the server answer's assessed scope.
  assert.match(fleetHealth, /assessed\.push\(ref\)/);
  // DIRECTION.md, Home: the server answer preserves the stream audit result in coverage_audit.
  assert.match(fleetHealth, /coverage_audit: input\.streamHealth\.status/);
  // DIRECTION.md, Home: unobserved can produce a failing stream audit and is not owner-caused.
  assert.match(fleetHealth, /const FAIL_PRODUCING_STREAM_HEALTH_CLASSES = \[[\s\S]*?"unobserved"/);
  const ownerClasses =
    fleetHealth.match(/const OWNER_CAUSED_STREAM_HEALTH_CLASSES = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  // DIRECTION.md, Home: unobserved is excluded from the owner-caused class set.
  assert.doesNotMatch(ownerClasses, /"unobserved"/);
  // DIRECTION.md, Home: that system-caused fail reaches the global banner.
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
  // DIRECTION.md, Home: source rows provide the title and never-synced rows are not an alarm.
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
      ownerClients: [
        { active_token_count: 0, client_id: "Atlas Mortgage", client_name: "Atlas Mortgage", created_at: SUCCESS },
        { active_token_count: 0, client_id: "Northstar HR", client_name: "Northstar HR", created_at: SUCCESS },
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
  // Lead decision (home-pictures 1): the sync-started time follows the status words, in lower case.
  assert.match(data.needs[0]?.syncNote ?? "", /^sync started /);
  // Lead decision (home-pictures 1): status words sit on their own line, capital first, as the wording function gives them.
  assert.equal(data.needs.find((need) => need.name === "Amazon")?.status?.words, "Needs to get ready again");
  // DIRECTION.md, Home § Needs you: approval rows use the existing review destination.
  assert.equal(data.needs.find((need) => need.kind === "approval")?.actionHref, HREFS.grants);
  // DIRECTION.md, Home § Needs you: source action links land on that source's detail page.
  assert.equal(data.needs.find((need) => need.name === "Amazon")?.actionHref, HREFS.source(oldOther.connection_id));
});

test("the needs-you box holds exactly the rows whose status says needs you", () => {
  const sources = [
    statusSource(2, "Setup shell"),
    statusSource(4, "Needs install"),
    statusSource(9, "Setting up"),
    statusSource(10, "Paused"),
    statusSource(11, "Syncing"),
    statusSource(20, "Healthy"),
  ];
  const data = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources } }));
  const expected = sources
    .filter((source) => sourceStatusWords(source, { now: NOW }).needsYou)
    .map((source) => source.connection_id);

  // Lead decision (home-pictures 5): only rows where needsYou is true enter the box; setup never completed (row 2) does not.
  assert.deepEqual(
    data.needs.map((need) => need.id).sort(),
    [...expected].sort(),
  );
  assert.deepEqual(
    data.needs.map((need) => need.name).sort(),
    ["Needs install", "Setting up"],
  );

  for (const scenario of ["calm", "alarm", "decide"] as const) {
    const inputs = buildDemoInputs(scenario, HREFS);
    const demo = buildHomeViewModel(inputs);
    // Lead decision (home-pictures 5): the seeded samples obey the same rule.
    assert.deepEqual(
      demo.needs.filter((need) => need.source).map((need) => need.id).sort(),
      inputs.sourcePage.sources
        .filter((source) => sourceStatusWords(source, { now: inputs.now }).needsYou)
        .map((source) => source.connection_id)
        .sort(),
    );
  }
});

test("a needs-you row says when it last synced only after a successful sync", () => {
  const synced = statusSource(4, "Amazon");
  const neverSynced = statusSource(9, "Notion", { connection_health: health({ last_success_at: null }) });
  const data = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources: [synced, neverSynced] } }));

  // Lead decision (home-pictures 2): "last synced" appears only when the data source has a successful sync.
  assert.match(data.needs.find((need) => need.name === "Amazon")?.syncNote ?? "", /^last synced /);
  assert.equal(data.needs.find((need) => need.name === "Notion")?.syncNote, null);
  // Lead decision (home-pictures 1): the status words stay on the second line, capital first.
  assert.equal(data.needs.find((need) => need.name === "Notion")?.status?.words, "Setup in progress");
});

test("Home names a waiting request from the app name in its grants read", () => {
  const clientId = "https://console.example/oauth/client-metadata/client-1";
  const data = buildHomeViewModel(
    base({
      approvals: [approval("approval-1", clientId, SUCCESS)],
      grants: [
        {
          ...grant("grant-1", clientId),
          client: { client_id: clientId, client_name: "Listening recap", registration_mode: "dynamic" },
        },
      ],
    }),
  );

  // round5 item 1: Home uses the known app name from the data already read for Apps.
  assert.equal(data.needs.find((need) => need.kind === "approval")?.name, "Listening recap");
});

test("each seeded sample's counts agree with its own rows", () => {
  for (const scenario of ["calm", "alarm", "decide"] as const) {
    const inputs = buildDemoInputs(scenario, HREFS);
    const rows = inputs.sourcePage.sources;
    const records = rows.reduce((sum, source) => sum + (source.total_records ?? 0), 0);
    // Lead decision (home-pictures 6): "N data sources · N records" is made from the rows the sample shows.
    assert.equal(
      buildHomeViewModel(inputs).subtitle,
      `${rows.length} data sources · ${records.toLocaleString("en-US")} records`,
    );
  }

  const calm = buildDemoInputs("calm", HREFS).sourcePage.sources;
  const words = calm.map((source) => sourceStatusWords(source, { now: NOW }));
  // Lead decision (home-pictures 6): calm lists at least six rows mixing up to date and imported.
  assert.ok(calm.length >= 6);
  assert.ok(words.some((status) => status.row === 19));
  assert.ok(words.some((status) => status.row === 18));
  // Calm shows the calm title, so no calm row syncs; "Syncing <name>" stays pinned by its own test.
  assert.ok(words.every((status) => status.row !== 11));
  assert.equal(buildHomeViewModel(buildDemoInputs("calm", HREFS)).title, "Everything is up to date");
  // A paused row would stop the calm title, so calm has none.
  assert.ok(words.every((status) => status.row !== 10));
  assert.ok(words.every((status) => !status.needsYou));
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
  // DIRECTION.md, Home: a continuation makes the title neutral.
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
  // DIRECTION.md, Home: a failed source read cannot claim what it might have shown.
  assert.equal(sourceFailed.title, "Data sources");
  // DIRECTION.md, Home: source failure gets a section-local error state.
  assert.equal(sourceFailed.dataSourceError, true);
  // DIRECTION.md, Home § First run: failed reads do not turn into the first-run page.
  assert.equal(sourceFailed.firstRun, false);

  const approvalFailed = buildHomeViewModel(
    base({
      approvalsFailed: true,
      sourcePage: { hasMore: false, kind: "ok", sources: currentSources },
    }),
  );
  // DIRECTION.md, Home: a failed approval read makes the title neutral.
  assert.equal(approvalFailed.title, "Data sources");
  // DIRECTION.md, Home: the needs-you section reports the failed read.
  assert.equal(approvalFailed.needsError, true);
});

test("summary totals stay honest when the summary is stale, unknown, or failed", () => {
  const stale = buildHomeViewModel(base({ summary: { ...SUMMARY, projection: { state: "stale" } } }));
  // DIRECTION.md, Home: stale record totals are omitted.
  assert.equal(stale.recordCount, null);
  // DIRECTION.md, Home: stale totals show the plain status link.
  assert.equal(stale.warning, true);
  // The connection count lives in the same projection as the record count, so a
  // stale summary's count is not trusted: a full source list is counted instead.
  assert.equal(stale.dataSourceCount, "0");
  const threeSources = { hasMore: false, kind: "ok" as const, sources: [statusSource(20, "GitHub"), statusSource(20, "Reddit"), statusSource(20, "Spotify")] };
  const staleZero = buildHomeViewModel(
    base({ sourcePage: threeSources, summary: { ...SUMMARY, connector_count: 0, projection: { state: "stale" } } }),
  );
  assert.equal(staleZero.subtitle, "3 data sources");
  const stalePaged = buildHomeViewModel(
    base({ sourcePage: { ...threeSources, hasMore: true }, summary: { ...SUMMARY, projection: { state: "stale" } } }),
  );
  assert.equal(stalePaged.dataSourceCount, null);

  const unknown = buildHomeViewModel(base({ summary: { ...SUMMARY, projection: undefined } }));
  // DIRECTION.md, Home: unknown summary state does not prove a current record total.
  assert.equal(unknown.recordCount, null);

  // DIRECTION.md, Home: "N data sources · N records" under the title, counted words in the singular for one.
  assert.equal(buildHomeViewModel(base()).subtitle, "4 data sources · 48,120 records");
  assert.equal(
    buildHomeViewModel(base({ summary: { ...SUMMARY, connector_count: 1, record_count: 1 } })).subtitle,
    "1 data source · 1 record",
  );
  // DIRECTION.md, Home: "Leave out the record total when the server marks it stale or unknown."
  assert.equal(stale.subtitle, "0 data sources");
  assert.equal(unknown.subtitle, "0 data sources");

  const failed = buildHomeViewModel(base({ summary: null, summaryFailed: true }));
  // DIRECTION.md, Home: a failed summary has a local retry state.
  assert.equal(failed.summaryError, true);
});

test("Home names the data sources an app can read, not event kinds", () => {
  const data = buildHomeViewModel(base({
    grants: [
      { ...grant("g1", "Listening recap", ["token.issued"]), source: { id: "spotify", kind: "connector" } },
      { ...grant("g2", "Listening recap", ["read.success"]), source: { id: "github", kind: "connector" } },
    ],
  }));
  // DIRECTION.md, Home § Apps that can read your data: name the first data source in the access.
  // DIRECTION.md, Home § Apps that can read your data: include the next data source in the access.
  assert.equal(data.apps[0]?.reads, "Spotify and GitHub");
});

test("Home does not show the page warning for failures in section-local reads", () => {
  const data = buildHomeViewModel(base({
    approvalsFailed: true,
    grantsFailed: true,
    ownerClientsFailed: true,
    sourcePage: { hasMore: false, kind: "ok", sources: [statusSource(19, "Spotify")] },
    tracesFailed: true,
  }));
  // DIRECTION.md, Home: optional failed reads use their affected section, not the page warning.
  assert.equal(data.warning, false);
  // DIRECTION.md, Home: a failed approval read remains visible in Needs you.
  assert.equal(data.needsError, true);
  // DIRECTION.md, Home: failed app reads remain visible in the Apps section.
  assert.equal(data.appError, true);
});

test("each read that no longer raises the page warning never reads as an empty fact", () => {
  const healthy = { hasMore: false, kind: "ok" as const, sources: [statusSource(19, "Spotify")] };
  const calm = ["Nothing needs you", "Everything is up to date"];

  const approvals = buildHomeViewModel(base({ approvalsFailed: true, sourcePage: healthy }));
  // Intake round56 item 1: a failed approvals read must not say that nothing needs the owner.
  assert.ok(!calm.includes(approvals.title));
  // Intake round56 item 1: Needs you stays on screen and says it could not load.
  assert.equal(approvals.needsVisible, true);
  assert.equal(approvals.needsError, true);

  for (const failed of ["grantsFailed", "tracesFailed", "ownerClientsFailed"] as const) {
    const apps = buildHomeViewModel(base({ [failed]: true, sourcePage: healthy }));
    // Intake round56 item 1: a failed app read does not claim that no app can read the data.
    assert.equal(apps.appsEmpty, false, failed);
    // Intake round56 item 1: the Apps section says it could not load.
    assert.equal(apps.appError, true, failed);
    assert.equal(apps.firstRun, false, failed);
  }

  const sources = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "error", sources: [] } }));
  // Intake round56 item 1: a failed source read is not a first run and not "No data sources yet."
  assert.equal(sources.firstRun, false);
  assert.equal(sources.noSources, false);
  // Intake round56 item 1: the Data sources section says it could not load.
  assert.equal(sources.dataSourceError, true);
  assert.ok(!calm.includes(sources.title));
});

test("Home labels the successful read time in sentence case", async () => {
  const src = await readFile(new URL("./standing-overview.tsx", import.meta.url), "utf8");
  // DIRECTION.md, Home § Apps that can read your data: use the same sentence-case label as Apps.
  const row = src.slice(src.indexOf("function AppRow"), src.indexOf("function AppsBlock"));
  assert.match(row, /Last read \{app\.lastRead\}/);
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
        { ...grant("g1", "Atlas", ["pay_statements"]), source: { id: "spotify", kind: "connector" } },
        { ...grant("g2", "Atlas", ["transactions"]), source: { id: "github", kind: "connector" } },
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

  // DIRECTION.md, Home § Apps that can read your data: a client with multiple active permissions gets one row.
  assert.equal(data.apps.length, 1);
  // DIRECTION.md, Home § Apps that can read your data: the app summary names its data sources.
  assert.equal(data.apps[0]?.reads, "Spotify and GitHub");
  // DIRECTION.md, Home § Apps that can read your data: grouped grants use the full access list address.
  assert.equal(data.apps[0]?.href, HREFS.grant("g1"));
  // The permission list supplies the last-read time. by the same app supplies last-read text.
  assert.match(data.apps[0]?.lastRead ?? "", /ago|today|yesterday/);
  // DIRECTION.md, Home § Apps that can read your data: token rows count active owner-made tokens directly.
  assert.equal(data.activeTokenCount, 1);
});

test("single app links, token links, and empty-state conditions are exact", () => {
  const singleGrant = buildHomeViewModel(base({ grants: [grant("g1", "Atlas")] }));
  // DIRECTION.md, Home § Apps that can read your data: one permission uses the matching access page.
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
  // DIRECTION.md, Home § Apps that can read your data: access tokens have their own management address.
  assert.equal(withTokens.tokensHref, HREFS.deploymentTokens);
  // DIRECTION.md, Home § Apps that can read your data: an active owner token prevents the no-app empty state.
  assert.equal(withTokens.appsEmpty, false);

  const empty = buildHomeViewModel(base());
  // DIRECTION.md, Home § Apps that can read your data: the no-app message appears only when both access reads are complete.
  assert.equal(empty.appsEmpty, true);
  const grantsIncomplete = buildHomeViewModel(base({ grantsHaveMore: true }));
  // DIRECTION.md, Home § Apps that can read your data: incomplete permission data cannot claim no app has access.
  assert.equal(grantsIncomplete.appsEmpty, false);
  const ownerClientsFailed = buildHomeViewModel(base({ ownerClientsFailed: true }));
  // DIRECTION.md, Home § Apps that can read your data: a failed token read cannot claim no app has access.
  assert.equal(ownerClientsFailed.appsEmpty, false);
  // DIRECTION.md, Home: affected app data carries a retry state.
  assert.equal(ownerClientsFailed.appError, true);
});

test("the apps section links to all apps at twelve permissions and suppresses false empty states", () => {
  const twelveGrants = Array.from({ length: 12 }, (_, index) => grant(`grant-${index}`, `App ${index}`));
  const exactLimit = buildHomeViewModel(base({ grants: twelveGrants }));
  // DIRECTION.md, Home § Apps that can read your data: reaching the permissions limit adds the all-apps link.
  assert.equal(exactLimit.allAppsLink, true);
  // DIRECTION.md, Home § Apps that can read your data: the all-apps link points to the full permissions page.
  assert.equal(exactLimit.allAppsHref, HREFS.grants);

  const tracesFailed = buildHomeViewModel(base({ tracesFailed: true }));
  // DIRECTION.md, Home § Apps that can read your data: incomplete reads suppress the no-app message.
  assert.equal(tracesFailed.appsEmpty, false);
  // DIRECTION.md, Home: failed reads remain visible as a soft error.
  assert.equal(tracesFailed.appError, true);
});

test("the seeded demos exercise every active status row through the shared status function", () => {
  const scenarios: DemoScenario[] = ["calm", "alarm", "decide"];
  const rows = scenarios.flatMap((scenario) =>
    buildDemoInputs(scenario, HREFS).sourcePage.sources.map((source) => sourceStatusWords(source, { now: NOW }).row),
  );
  // DIRECTION.md, PAGE-RULES 8 (seeded demos): every visible status row appears in at least one seeded scenario.
  assert.deepEqual(
    Array.from(new Set(rows)).sort((left, right) => left - right),
    Array.from({ length: 21 }, (_, index) => index + 4),
  );
});

test("every status fixture named after a row lands on that row", () => {
  // DIRECTION.md, "One status, from one place": each fixture is named by the row it must reach.
  for (const row of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 21, 22, 23, 24]) {
    assert.equal(sourceStatusWords(statusSource(row, `Row ${row}`), { now: NOW }).row, row, `fixture for row ${row}`);
  }
});

test("a read with more than it returned is not a failure: show what was read and link to the full list", () => {
  const moreApprovals = buildHomeViewModel(
    base({
      approvals: [approval("a1", "Atlas Mortgage", SUCCESS)],
      approvalsHaveMore: true,
      sourcePage: { hasMore: false, kind: "ok", sources: [statusSource(19, "Spotify")] },
    }),
  );
  // Lead decision (deputy-fixes-1 E4): `has_more` on app requests shows the rows read, no failure line.
  assert.equal(moreApprovals.needs.length, 1);
  assert.equal(moreApprovals.needsError, false);
  assert.equal(moreApprovals.needsMore, true);
  assert.equal(moreApprovals.warning, false);
  // DIRECTION.md, Home: "When there is more than it read, it never says 'everything' or 'no'".
  assert.equal(moreApprovals.title, "Data sources");

  const moreClients = buildHomeViewModel(
    base({
      grants: [grant("g1", "Atlas")],
      ownerClients: [{ active_token_count: 2, client_id: "owner", client_name: "Owner tool", created_at: SUCCESS }],
      ownerClientsHaveMore: true,
    }),
  );
  // Lead decision (deputy-fixes-1 E4): `has_more` on owner-made clients is not "This could not be loaded."
  assert.equal(moreClients.appError, false);
  assert.equal(moreClients.warning, false);
  // DIRECTION.md, Home: "No count is ever made by subtraction"; a short page gives a link, not a count.
  assert.equal(moreClients.activeTokenCount, 0);
  assert.equal(moreClients.allTokensLink, true);
  assert.equal(moreClients.appsEmpty, false);
  assert.equal(moreClients.apps.length, 1);

  const failedClients = buildHomeViewModel(base({ ownerClientsFailed: true }));
  // A real failure still reports itself and gives no full-list link.
  assert.equal(failedClients.appError, true);
  assert.equal(failedClients.allTokensLink, false);
});

test("no data sources but an app: the top says so with the one filled button", () => {
  const data = buildHomeViewModel(base({ grants: [grant("g1", "Atlas")] }));
  // Lead decision (deputy-fixes-1 E5): not first run, and not "Nothing needs you".
  assert.equal(data.firstRun, false);
  assert.equal(data.noSources, true);
  assert.equal(data.title, "No data sources yet.");

  const withRequest = buildHomeViewModel(
    base({ approvals: [approval("a1", "Atlas Mortgage", SUCCESS)], grants: [grant("g1", "Atlas")] }),
  );
  // DIRECTION.md, Home: a thing that needs the person keeps the title and its own filled button.
  assert.equal(withRequest.title, "1 thing needs you");
  assert.equal(withRequest.noSources, false);
});

test("more than twelve data sources: a complete read names the total, a paged read keeps the paged wording", () => {
  const sources = Array.from({ length: 14 }, (_, index) =>
    statusSource(20, `Source ${String(index + 1).padStart(2, "0")}`),
  );
  const complete = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources } }));
  // DIRECTION.md, Home § Data sources: "More than twelve: show twelve and 'All N data sources'."
  assert.equal(complete.sourceTotalLink, "All 14 data sources");

  const paged = buildHomeViewModel(base({ sourcePage: { hasMore: true, kind: "ok", sources } }));
  // DIRECTION.md, Home: a read with more than it read names no total.
  assert.equal(paged.sourceTotalLink, null);
  assert.equal(paged.showMoreSources, true);
});

test("the record total shows while the summary is refreshing, not while rebuilding", () => {
  // Lead decision (deputy-fixes-1 E7): refreshing still carries the last known total.
  assert.equal(
    buildHomeViewModel(base({ summary: { ...SUMMARY, projection: { state: "refreshing" } } })).subtitle,
    "4 data sources · 48,120 records",
  );
  // DIRECTION.md, Home: "Leave out the record total when the server marks it stale or unknown."
  assert.equal(
    buildHomeViewModel(base({ summary: { ...SUMMARY, projection: { state: "rebuilding" } } })).subtitle,
    // Not current, so the source count is the full list's length (empty in this fixture).
    "0 data sources",
  );
});

test("Home names a connection by the shared rule: a saved connector key is not a name", () => {
  // Round 3 brief item 2: one connection-name rule for the whole console.
  const keyNamed = statusSource(20, "Reddit", { connector_display_name: "Reddit", connector_id: "reddit", display_name: "reddit" });
  const syncing = statusSource(11, "GitHub", { connector_display_name: "GitHub", connector_id: "github", display_name: "GITHUB" });
  const data = buildHomeViewModel(base({ sourcePage: { hasMore: false, kind: "ok", sources: [keyNamed, syncing] } }));

  assert.deepEqual(data.dataSources.map((row) => row.name), ["GitHub", "Reddit"]);
  assert.equal(data.title, "Syncing GitHub");
});
