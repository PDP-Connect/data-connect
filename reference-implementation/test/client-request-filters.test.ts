// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import {
  clientFilterBinding,
  compileClientRequestFilters,
  type FilterField,
  parseFilterRecordJson,
  retainClientFilterEntries,
} from "../server/client-request-filters.ts";
import {
  createRetainedCoreConsentSnapshot,
  materializeCoreResolvedGrant,
  parseCoreResolvedGrant,
} from "../server/core-source-authorization.ts";
import { compileRequestFilters, passesRequestFilters, rejectUnsupportedClientQuery } from "../server/record-filters.ts";
import { buildReadRequest } from "../vendor/cli/src/read/commands.ts";

const qs = createRequire(import.meta.url)("qs") as { parse: (raw: string) => Record<string, unknown> };

const filter_fields: Record<string, FilterField> = {
  text: { type: "string", range: [] },
  flag: { type: "boolean", range: [] },
  int: { type: "integer", range: ["gt", "gte", "lt", "lte"] },
  num: { type: "number", range: ["gte", "lt"] },
  day: { type: "date", range: ["gte", "lt"] },
  time: { type: "date-time", range: ["gte", "lt"] },
};
const grant = { fields: [...Object.keys(filter_fields), "opaque"], filter_fields };
function query(raw: string) {
  return retainClientFilterEntries(qs.parse(raw), raw);
}
function matches(type: FilterField["type"], operand: string, json: string) {
  return passesRequestFilters(
    parseFilterRecordJson(json),
    compileClientRequestFilters(
      { value: operand },
      {
        fields: ["value"],
        filter_fields: { value: { type, range: [] } },
      }
    )
  );
}

test("client filter errors authorize all fields before typed validation", () => {
  assert.throws(
    () => compileClientRequestFilters(query("filter[num]=bad&filter[hidden]=x&filter[absent]=x").filter, grant),
    {
      code: "field_not_granted",
      param: "filter[hidden]",
      message: "Fields not in grant: hidden, absent",
    }
  );
});

for (const [raw, param] of [
  ["filter[opaque]=x&filter[int]=bad", "filter[opaque]"],
  ["filter[num][gt]=1", "filter[num][gt]"],
  ["filter[text][eq]=x", "filter[text][eq]"],
  ["filter[text][gte]=x", "filter[text][gte]"],
  ["filter[text]=x&filter[num]=bad&filter[text]=x", "filter[num]"],
  ["filter[text]=x&filter[text]=y", "filter[text]"],
  ["filter[int][gt]=1&filter[flag]=TRUE&filter[int][gt]=2", "filter[flag]"],
  ["filter[int][gt]=1&filter[int][gt]=2", "filter[int][gt]"],
  ["filter[int]=1.5", "filter[int]"],
  ["filter[num]=01", "filter[num]"],
  ["filter[day]=2026-02-30", "filter[day]"],
  ["filter[time]=2026-01-01T00:00:00", "filter[time]"],
] as const) {
  test(`client filter rejects the first invalid parameter: ${raw}`, () => {
    assert.throws(() => compileClientRequestFilters(query(raw).filter, grant), { code: "invalid_request", param });
  });
}

test("legacy client grants reject all filters before field checks", () => {
  for (const filter of [{ text: "x" }, { absent: { nope: "bad" } }]) {
    assert.throws(() => rejectUnsupportedClientQuery("client", { filter }, { fields: ["text"] }), {
      code: "invalid_request",
      param: "filter",
    });
  }
  assert.doesNotThrow(() => rejectUnsupportedClientQuery("client", { filter: { text: "x" } }, grant));
  assert.throws(() => rejectUnsupportedClientQuery("client", { expand: ["child"] }, grant), {
    code: "invalid_request",
  });
});

test("frozen strings and booleans require the correct stored JSON type", () => {
  assert.equal(matches("string", "é", '{"value":"é"}'), true);
  assert.equal(matches("string", "é", '{"value":"é"}'), false);
  assert.equal(matches("string", "true", '{"value":true}'), false);
  assert.equal(matches("boolean", "true", '{"value":true}'), true);
  assert.equal(matches("boolean", "false", '{"value":false}'), true);
  assert.equal(matches("boolean", "true", '{"value":"true"}'), false);
});

test("absent, null and wrong JSON types never satisfy a frozen filter", () => {
  for (const [type, operand] of [["string", "null"], ["boolean", "false"], ["number", "0"], ["integer", "0"], ["date", "2026-01-01"], ["date-time", "2026-01-01T00:00:00Z"]] as const) {
    for (const json of ["{}", '{"value":null}', '{"value":[]}', '{"value":{}}']) {
      assert.equal(matches(type, operand, json), false, `${type}: ${json}`);
    }
  }
});

test("numeric comparisons preserve stored and operand precision", () => {
  assert.equal(matches("integer", "9007199254740993", '{"value":9007199254740993}'), true);
  assert.equal(matches("integer", "9007199254740992", '{"value":9007199254740993}'), false);
  assert.equal(matches("number", "0.100000000000000001", '{"value":0.100000000000000001}'), true);
  assert.equal(matches("number", "0.1", '{"value":0.100000000000000001}'), false);
  assert.equal(matches("integer", "1e1", '{"value":10.00}'), true);
  assert.equal(matches("integer", "-0.0", '{"value":0}'), true);
  assert.equal(matches("integer", "1", '{"value":1.00000000000000001}'), false);
  assert.equal(matches("number", "1e999999999", '{"value":1e999999999}'), true);
  assert.equal(matches("number", "10", '{"value":"10"}'), false);
  for (const operand of ["+1", "01", ".1", "1.", " 1", "NaN", "Infinity", "0x10"]) {
    assert.throws(() => compileClientRequestFilters({ num: operand }, grant), {
      code: "invalid_request",
      param: "filter[num]",
    });
  }
});

test("client ranges combine with AND and use exact mathematical order", () => {
  const compiled = compileClientRequestFilters(
    query("filter[int]=1e1&filter[int][gte]=10&filter[num][lt]=0.100000000000000002").filter,
    grant
  );
  assert.equal(passesRequestFilters(parseFilterRecordJson('{"int":10,"num":0.100000000000000001}'), compiled), true);
  assert.equal(passesRequestFilters(parseFilterRecordJson('{"int":10,"num":0.100000000000000002}'), compiled), false);
  for (const json of ["{}", '{"int":null}', '{"int":"10"}', '{"int":[]}', '{"int":true}']) {
    assert.equal(passesRequestFilters(parseFilterRecordJson(json), compiled), false);
  }
});

test("date-time filters compare instants and retain fractional seconds and leap seconds", () => {
  assert.equal(
    matches("date-time", "2026-01-01t00:00:00.123456789z", '{"value":"2025-12-31T19:00:00.123456789-05:00"}'),
    true
  );
  assert.equal(
    matches("date-time", "2026-01-01T00:00:00.123456788Z", '{"value":"2026-01-01T00:00:00.123456789Z"}'),
    false
  );
  assert.equal(matches("date-time", "2016-12-31T23:59:60Z", '{"value":"2017-01-01T00:59:60+01:00"}'), true);
  assert.equal(matches("date-time", "2017-01-01T00:00:00Z", '{"value":"2016-12-31T23:59:60Z"}'), false);
  assert.equal(matches("date-time", "2026-01-01T00:00:00-00:00", '{"value":"2026-01-01T00:00:00Z"}'), true);
  assert.equal(matches("date", "2024-02-29", '{"value":"2024-02-29"}'), true);
  assert.equal(matches("date", "2024-02-29", '{"value":"2024-02-29T00:00:00Z"}'), false);
  assert.throws(() => compileClientRequestFilters({ time: "2026-01-01T23:59:60Z" }, grant), {
    code: "invalid_request",
  });
});

test("client filters never inspect mutable declaration schemas", () => {
  const manifest = Object.defineProperty({}, "schema", {
    get() {
      throw new Error("declaration read");
    },
  });
  assert.equal(passesRequestFilters({ int: 10 }, compileRequestFilters({ int: "10" }, grant, manifest)), true);
});

test("filter bindings ignore order but retain decoded operand spelling", () => {
  const a = query("filter[int][gte]=10&filter[text]=a%20b").filter;
  assert.deepEqual(clientFilterBinding(a), clientFilterBinding(query("filter[text]=a+b&filter[int][gte]=10").filter));
  assert.notDeepEqual(
    clientFilterBinding(a),
    clientFilterBinding(query("filter[text]=a+b&filter[int][gte]=1e1").filter)
  );
});

test("issuance negotiates versions and freezes nullable scalar types and declared ranges", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url), "utf8")
  );
  const declaration = fixture.source_declaration;
  declaration.streams = [
    {
      name: "items",
      primary_key: ["text"],
      semantics: "mutable_state",
      selection: { fields: true, resources: true },
      schema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          flag: { type: ["null", "boolean"] },
          int: { type: ["integer", "null"] },
          num: { type: "number" },
          time: { type: ["string", "null"], format: "date-time" },
          day: { type: "string", format: "date" },
          array: { type: "array", items: { type: "string" } },
          mixed: { type: ["integer", "string"] },
        },
      },
      query: { range_filters: { int: ["gte"], time: ["lt"], num: ["gte", "lt"] } },
    },
  ];
  const selection = {
    type: "https://pdpp.dev/data-access",
    access_mode: "continuous",
    purpose_code: "https://pdpp.dev/purpose/personalization",
    streams: [{ name: "items", instance_ids: ["instance_1"] }],
  };
  const snapshot = createRetainedCoreConsentSnapshot({
    declaration,
    selection,
    source: declaration.source,
    sourceSensitivity: "standard",
  });
  const args = {
    accessMode: selection.access_mode,
    clientId: "client_1",
    expiresAt: null,
    grantId: "grant_1",
    issuedAt: "2026-01-01T00:00:00Z",
    purposeCode: selection.purpose_code,
    resolvedStreams: snapshot.resolved_streams,
    snapshot,
    subjectId: "subject_1",
  };
  const legacy = materializeCoreResolvedGrant(args);
  assert.equal(legacy.version, "0.1.0");
  assert.equal(legacy.streams[0]?.filter_fields, undefined);
  const [selected] = snapshot.resolved_streams;
  assert.ok(selected);
  const noScalars = materializeCoreResolvedGrant({ ...args, grantVersion: "0.2.0", resolvedStreams: [{ ...selected, fields: ["array"] }] });
  assert.equal(noScalars.streams[0]?.filter_fields, undefined);
  const modern = materializeCoreResolvedGrant({ ...args, grantVersion: "0.2.0" });
  assert.equal(modern.version, "0.2.0");
  assert.deepEqual(modern.streams[0]?.filter_fields, {
    text: { type: "string", range: [] },
    flag: { type: "boolean", range: [] },
    int: { type: "integer", range: ["gte"] },
    num: { type: "number", range: ["gte", "lt"] },
    day: { type: "date", range: [] },
    time: { type: "date-time", range: ["lt"] },
  });
  assert.throws(() => parseCoreResolvedGrant({ ...modern, version: "0.1.0" }));
  assert.throws(() =>
    parseCoreResolvedGrant({
      ...modern,
      streams: [{ ...modern.streams[0], filter_fields: { outside: { type: "string", range: [] } } }],
    })
  );
});

test("CLI query-records preserves precise filter operands in bracket parameters", () => {
  const request = buildReadRequest(
    "query-records",
    ["items"],
    { "filter-json": '{"int":"9007199254740993","num":{"gte":"0.100000000000000001"}}' },
    JSON.parse(readFileSync(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url), "utf8"))
      .provider_id
  );
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("filter[int]"), "9007199254740993");
  assert.equal(url.searchParams.get("filter[num][gte]"), "0.100000000000000001");
});
