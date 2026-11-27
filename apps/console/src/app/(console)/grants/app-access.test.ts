// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { appSourceCount } from "./unused-apps.ts";
import type { AppAccess as Registration } from "../lib/ref-client.ts";
import { groupGrantAccessByApp, UNKNOWN_APP_NAME } from "./app-access.ts";

function registration(id = "one", patch: Partial<Registration> = {}): Registration {
  return {
    client_id: id,
    client_name: "ChatGPT",
    return_host: "chatgpt.com",
    returns_to_this_computer: false,
    domain_control_verified: true,
    reads_last_7_days: 0,
    sources: [
      {
        source: { kind: "connector", id: "gmail", connector_id: "gmail", connection_id: "mail" },
        kinds: ["messages"],
        in_force: true,
        first_issued_at: "2026-01-01T00:00:00Z",
        expires_at: null,
        stopped_at: null,
        stopped_reason: null,
        last_read_at: null,
        grant_ids: [id],
        active_grant_ids: [id],
        package_ids: [],
      },
    ],
    ...patch,
  };
}
test("address-derived names keep different products on one host separate", () => {
  const apps = groupGrantAccessByApp([
    registration("https://tools.example/one", { client_name: "tools.example", client_name_source: "client_id" }),
    registration("https://tools.example/two", { client_name: "tools.example", client_name_source: "client_id" }),
    registration("https://chatgpt.com/chat", { client_name: "ChatGPT" }),
    registration("https://chatgpt.com/other", { client_name: "ChatGPT" }),
    registration("https://chatgpt.com/codex", { client_name: "Codex" }),
  ]);
  assert.equal(apps.length, 4);
  assert.equal(apps.find((a) => a.name === "ChatGPT")?.clientIds.length, 2);
  assert.equal(apps.filter((a) => a.name === "tools.example").length, 2);
});

test("same name AND return host merge, preserving every old permission address", () => {
  const rows = groupGrantAccessByApp([
    registration(),
    registration("two"),
    registration("three", { return_host: "lookalike.example" }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]?.grantIds, ["one", "two"]);
  assert.equal(rows[0]?.sourceAccess.length, 1);
  assert.ok(rows.find((app) => app.grantIds.includes("two"))?.clientIds.includes("two"));
});
test("loopback shares this computer; missing address groups by name; fully unnamed stands alone", () => {
  const rows = groupGrantAccessByApp([
    registration("a", { returns_to_this_computer: true, return_host: "localhost" }),
    registration("b", { returns_to_this_computer: true, return_host: "127.0.0.1" }),
    registration("c", { return_host: null }),
    registration("d", { return_host: null }),
    registration("e", { client_name: "", return_host: null }),
    registration("f", { client_name: "", return_host: null }),
    registration("g", { client_name: "" }),
  ]);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => row.name === UNKNOWN_APP_NAME).length, 2);
  assert.ok(rows.some((row) => row.name === "chatgpt.com"));
});
test("expiry overrides in force; an event outcome is never an input", () => {
  const item = registration();
  item.sources[0]!.expires_at = "2026-01-02T00:00:00Z";
  assert.equal(groupGrantAccessByApp([item], Date.parse("2026-01-03"))[0]?.state, "stopped");
  item.sources[0]!.expires_at = null;
  assert.equal(groupGrantAccessByApp([item])[0]?.state, "reading");
  item.sources[0]!.in_force = false;
  assert.equal(groupGrantAccessByApp([item])[0]?.state, "stopped");
});
test("every merged registration must be verified; kinds union without mutating input", () => {
  const a = registration();
  const b = registration("two", { domain_control_verified: false });
  b.sources[0]!.kinds = ["threads"];
  const before = structuredClone([a, b]);
  const app = groupGrantAccessByApp([a, b])[0]!;
  assert.equal(app.verified, false);
  assert.deepEqual(app.sourceAccess[0]?.kinds, ["messages", "threads"]);
  assert.deepEqual([a, b], before);
});
test("waiting requests use the same app identity without claiming permission", () => {
  const rows = groupGrantAccessByApp([registration()], Date.now(), [
    {
      object: "approval",
      approval_id: "request",
      batch: false,
      kind: "consent",
      created_at: "2026-11-25T00:00:00Z",
      client_id: "one",
    },
  ]);
  assert.equal(rows.filter((row) => row.state === "waiting").length, 1);
  const waiting = rows.find((row) => row.state === "waiting");
  assert.equal(waiting?.name, "ChatGPT");
  assert.deepEqual(waiting?.grantIds, []);
});
test("connection names and the all-sources phrase come only from a complete inventory", () => {
  const names = new Map([["mail", "Gmail (work)"]]);
  const [app] = groupGrantAccessByApp([registration()], Date.now(), [], names);
  assert.deepEqual(app?.sources, ["Gmail (work)"]);
  assert.equal(app?.readsAllSources, true);
  names.set("personal-mail", "Gmail (personal)");
  assert.equal(groupGrantAccessByApp([registration()], Date.now(), [], names)[0]?.readsAllSources, false);
});

test("the app summary and detail count the same connection rows even when labels are identical", () => {
  const registrations = [registration()];
  const first = registrations[0]!;
  first.sources = [
    { ...first.sources[0]!, source: { ...first.sources[0]!.source, connection_id: "one" } },
    { ...first.sources[0]!, source: { ...first.sources[0]!.source, connection_id: "two" } },
  ];
  const app = groupGrantAccessByApp(registrations)[0]!;
  assert.equal(app.sources.length, app.sourceAccess.filter((source) => source.in_force).length);
  assert.equal(app.sources.length, 2);
});

test("all-data access has one row per inventory source including service-wide duplicates", () => {
  const row = registration(); const [base]=row.sources; assert.ok(base);
  row.sources=[base,{...base,source:{...base.source,connection_id:null},all_accounts:true,connection_ids:["mail","other"],kinds:["threads"]},{...base,source:{...base.source,connection_id:"other"}}];
  const [app]=groupGrantAccessByApp([row],Date.now(),[],new Map([["mail","Gmail work"],["other","Gmail personal"]]));
  assert.equal(app?.readsAllSources,true);
  assert.equal(app?.sourceAccess.length,2);
  assert.equal(app?.sources.length,2);
  assert.ok(app?.sourceAccess.every(source=>!source.all_accounts));
});
test("service-wide access replaces accounts and only says all with several visible accounts", () => {
  const row=registration();const [base]=row.sources; assert.ok(base);
  row.sources=[base,{...base,source:{...base.source,connection_id:null},all_accounts:true,connection_ids:["mail","other"],kinds:["threads"]}];
  const names=new Map([["mail","Gmail work"],["other","Gmail personal"],["outside","Spotify"]]);
  const [app]=groupGrantAccessByApp([row],Date.now(),[],names);
  assert.equal(app?.sourceAccess.length,1);
  assert.ok(app);assert.equal(appSourceCount(app),2);
  assert.equal(app?.sourceAccess[0]?.name,"All Gmail accounts");
  names.delete("other");
  const [single]=groupGrantAccessByApp([row],Date.now(),[],names);
  assert.equal(single?.sourceAccess.length,1);
  assert.equal(single?.sourceAccess[0]?.name,"Gmail work");
});

test("stopped service-wide access never widens an active single-account permission",()=>{
 const row=registration();const [base]=row.sources;assert.ok(base);
 row.sources=[base,{...base,in_force:false,kinds:["threads"],source:{...base.source,connection_id:null},all_accounts:true,connection_ids:["mail","other"],active_grant_ids:[]}];
 const [app]=groupGrantAccessByApp([row],Date.now(),[],new Map([["mail","Gmail work"],["other","Gmail personal"],["outside","Spotify"]]));
 assert.ok(app);const current=app.sourceAccess.filter(source=>source.in_force);
 assert.equal(current.length,1);assert.equal(current[0]?.source.connection_id,"mail");
 assert.deepEqual(current[0]?.kinds,["messages"]);
});

// Round 8 B1: "can read" lists only what an active grant allows; a stopped or expired sibling adds nothing.
test("kinds from an expired grant never join the kinds an active grant can read", () => {
  const active = registration("active");
  active.sources[0]!.kinds = ["owned_games"];
  const expired = registration("old");
  expired.sources[0]!.kinds = ["steam_profile"];
  expired.sources[0]!.expires_at = "2026-01-02T00:00:00Z";
  const now = Date.parse("2026-02-01");
  assert.deepEqual(groupGrantAccessByApp([active, expired], now)[0]?.sourceAccess[0]?.kinds, ["owned_games"]);
  assert.deepEqual(groupGrantAccessByApp([expired, active], now)[0]?.sourceAccess[0]?.kinds, ["owned_games"]);
  const second = registration("second");
  second.sources[0]!.kinds = ["steam_profile"];
  assert.deepEqual(groupGrantAccessByApp([active, second], now)[0]?.sourceAccess[0]?.kinds, ["owned_games", "steam_profile"]);
});
