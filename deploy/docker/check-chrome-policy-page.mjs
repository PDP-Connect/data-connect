// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reads chrome://policy from a running browser over the Chrome DevTools
// Protocol and fails unless CADistrustedCertificates holds exactly the
// certificates in the expected policy file, from platform machine policy,
// at mandatory level, with status OK. Driven by check-chrome-distrust-policy.sh.
//
// Usage: node check-chrome-policy-page.mjs <debugging-port> <expected-policy.json> <label>
//
// Exit codes: 0 policy loaded as expected, 1 not loaded, wrong, unreadable or
// timed out, 2 usage.

import { readFileSync } from "node:fs";

const [port, expectedPath, label] = process.argv.slice(2);
if (!(port && expectedPath && label)) {
  console.error("usage: check-chrome-policy-page.mjs <debugging-port> <expected-policy.json> <label>");
  process.exit(2);
}
const POLICY = "CADistrustedCertificates";
const expected = JSON.parse(readFileSync(expectedPath, "utf8"))[POLICY];
// Polling for the endpoint and the policy row stops at `deadline`, which names
// what was missing; the watchdog below catches a step that never returns.
const TIMEOUT_MS = 60_000;
const deadline = Date.now() + 40_000;

function fail(message) {
  console.error(`${label}: ${message}`);
  process.exit(1);
}

// One watchdog bounds every step, including a DevTools reply that never comes.
setTimeout(() => fail(`no result within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);

async function browserWebSocketUrl() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return (await response.json()).webSocketDebuggerUrl;
      }
    } catch {
      // The browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`no DevTools endpoint on port ${port}`);
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { reject, resolve });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("DevTools connection closed"));
    pending.clear();
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ close: () => socket.close(), send }));
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
  });
}

// chrome://policy renders each policy as a <policy-row> custom element whose
// content sits in shadow roots; innerText does not reach it.
const READ_ROW = `(() => {
  const text = (root) => {
    let out = "";
    for (const node of root.childNodes) {
      if (node.nodeType === 3) out += node.textContent + " ";
      else if (node.nodeType === 1 && node.tagName !== "STYLE" && node.tagName !== "SCRIPT") {
        out += text(node);
        if (node.shadowRoot) out += text(node.shadowRoot);
      }
    }
    return out;
  };
  const rows = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "POLICY-ROW" && el.shadowRoot && el.shadowRoot.textContent.includes(${JSON.stringify(POLICY)})) {
        rows.push(text(el.shadowRoot));
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return { blocked: location.protocol === "chrome-error:", rows };
})()`;

// Every Chromium version checked (143 to 156) starts a row with the policy's
// source, scope, level and status, e.g. "Platform Machine Mandatory OK";
// some add labelled details after the value.
function parseRow(rowText) {
  const flat = rowText.replace(/\s+/g, " ").trim();
  const summary = / (\S+) (Machine|Current user) (Mandatory|Recommended) (\S+) /.exec(` ${flat} `);
  const valueStart = rowText.indexOf("[", rowText.search(/\bValue\b/));
  const valueEnd = rowText.indexOf("]", valueStart);
  let value;
  try {
    value = JSON.parse(rowText.slice(valueStart, valueEnd + 1));
  } catch {
    value = undefined;
  }
  return {
    level: summary?.[3],
    scope: summary?.[2],
    source: summary?.[1] === "Platform",
    status: summary?.[4],
    text: flat,
    value,
  };
}

const browser = await connect(await browserWebSocketUrl());
const { targetId } = await browser.send("Target.createTarget", { url: "chrome://policy" });
const { sessionId } = await browser.send("Target.attachToTarget", { flatten: true, targetId });

let row;
while (Date.now() < deadline) {
  const { result } = await browser.send("Runtime.evaluate", { expression: READ_ROW, returnByValue: true }, sessionId);
  const { blocked, rows } = result.value;
  if (blocked) fail("chrome://policy did not load (error page)");
  if (rows.length > 1) fail(`chrome://policy shows ${rows.length} ${POLICY} rows`);
  if (rows.length === 1) {
    row = parseRow(rows[0]);
    if (row.status && row.value) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
browser.close();

if (!row) fail(`chrome://policy does not list ${POLICY}; the browser did not read the policy file`);
if (!row.value) fail(`chrome://policy shows no ${POLICY} value: "${row.text.slice(0, 200)}"`);
const problems = [];
if (row.status !== "OK") problems.push(`status ${row.status}`);
if (row.scope !== "Machine") problems.push(`scope ${row.scope}`);
if (row.level !== "Mandatory") problems.push(`level ${row.level}`);
if (!row.source) problems.push("source is not Platform");
if (JSON.stringify(row.value) !== JSON.stringify(expected)) {
  problems.push(`value differs from ${expectedPath} (${row.value.length} of ${expected.length} entries)`);
}
if (problems.length > 0) fail(`${POLICY}: ${problems.join(", ")}`);
console.log(`${label}: ${POLICY} loaded (${expected.length} certificates, Platform, Machine, Mandatory, OK)`);
process.exit(0);
