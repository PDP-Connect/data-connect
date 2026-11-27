// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildServerPractice,
  plainServerChecks,
  checksHeadline,
} from "./plain-checks.ts"
for (const state of [
  "fine",
  "search-off",
  "attention",
  "blocked",
  "checking",
]) {
  test(`server practice ${state} has five checks and an honest verdict`, () => {
    const model = buildServerPractice(state)!
    const rows = plainServerChecks(model.inputs, model.address, model.probe)
    assert.equal(rows.length, 5)
    assert.doesNotMatch(
      rows.map(row => row.sentence).join(" "),
      /PDPP|readiness|origin|connector|deployment/
    )
    assert.match(
      checksHeadline(rows),
      state === "blocked"
        ? /can’t work/
        : state === "attention"
          ? /needs attention/
          : state === "checking"
            ? /Checking/
            : /Everything is working/
    )
  })
}

test("address repair matches desktop and server capabilities", () => {
  const model = buildServerPractice("fine")!;
  const desktop = plainServerChecks(model.inputs, "https://another.example", model.probe, true)[1]!;
  const server = plainServerChecks(model.inputs, "https://another.example", model.probe, false)[1]!;
  assert.equal(desktop.href, "/settings/remote-access");
  assert.equal(server.href, undefined);
  assert.match(server.action!, /where DataConnect is installed/);
});

test("the missing-password repair opens the sign-in page", () => {
  const model = buildServerPractice("blocked")!;
  const password = plainServerChecks(model.inputs, null, model.probe, true)[0]!;
  assert.equal(password.href, "/settings/sign-in");
});

test("a search check that could not run is not reported as working", () => {
  const model = buildServerPractice("fine")!;
  const inputs = { ...model.inputs, embeddingBackendAvailable: false, embeddingWarmStatus: null };
  const rows = plainServerChecks(inputs, model.address, model.probe);
  const search = rows.find(row => row.name === "Search")!;
  assert.match(search.sentence, /could not check/);
  assert.equal(search.status, "warn");
  assert.equal(checksHeadline(rows), "1 check needs attention.");
});

test("the headline is a status line, so no heading is left with only another heading under it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./server-checks.tsx", import.meta.url), "utf8");
  assert.match(source, /<Text as="p" role="status" size="heading">\{checksHeadline\(rows\)\}<\/Text>/);
});
