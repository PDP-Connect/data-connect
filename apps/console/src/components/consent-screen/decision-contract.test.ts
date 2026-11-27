// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import before from "./decision-before.json" with { type: "json" };
import { buildConsentDemoModel } from "./consent-screen-demo.ts";
const source = readFileSync(new URL("./consent-screen-client.tsx", import.meta.url), "utf8");
const after = source.slice(source.indexOf("  function buildDecision()"), source.indexOf("\n  async function submit"));
function run(
  body: string,
  model: ReturnType<typeof buildConsentDemoModel>,
  selection: Record<string, Record<string, boolean>>,
  expiry: string,
  noEndDate: boolean
) {
  const fields = Object.fromEntries(
    model.sources.flatMap((item) =>
      item.streams.map((stream) => [stream.id, Object.fromEntries(stream.fields.map((field) => [field.name, true]))])
    )
  );
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(
    "model",
    "selection",
    "ranges",
    "fieldSelection",
    "expiry",
    "noEndDate",
    `${js}; return buildDecision();`
  )(model, selection, {}, fields, expiry, noEndDate);
}
for (const duration of ["90d", "1y", "never"])
  for (const choice of ["two-all", "one-narrowed"])
    test(`${choice}, ${duration}: posted decision matches the old builder`, () => {
      const model = buildConsentDemoModel("normal");
      const selection = Object.fromEntries(
        model.sources.map((item, index) => [
          item.id,
          Object.fromEntries(
            item.streams.map((stream, streamIndex) => [
              stream.name,
              choice === "two-all" || (index === 0 && streamIndex === 0),
            ])
          ),
        ])
      );
      const expiry = duration === "1y" ? "2027-11-25" : "2027-02-23";
      const expected = run(before, model, selection, expiry, duration === "never");
      assert.deepEqual(run(after, model, selection, expiry, duration === "never"), expected);
      assert.equal(expected.sources.length, choice === "two-all" ? 2 : 1);
      assert.equal(expected.sources[0].streamNames.length, choice === "two-all" ? 2 : 1);
    });
test("the decision builder is byte identical", () => {
  assert.equal(after, before);
});
