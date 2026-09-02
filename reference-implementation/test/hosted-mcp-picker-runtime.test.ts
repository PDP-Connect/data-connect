// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime DOM regression coverage for the hosted MCP consent picker.
//
// Every other picker test asserts the rendered HTML/markup or the server-side
// POST outcome. None of them RUN the inline picker `<script>`. That left a real
// gap: the picker's interaction model (collapse-by-default, derive-source-from-
// streams, single-stream selection, client-side submit validation, bulk
// controls) lived entirely in browser JS that no test exercised, so a
// regression in that script would pass the whole suite while reproducing the
// exact symptoms a human reported in live UAT:
//
//   - all sources expanded by default
//   - nothing selected, yet every stream appeared selected
//   - selecting one stream without "select all" was confusing/impossible
//   - a stream selected without its parent produced a raw JSON invalid_request
//
// This file loads the real picker HTML the AS renders and executes its script
// in a real DOM (jsdom), then drives the picker the way a person would and
// asserts the resulting DOM state. It fails on each of the UAT regressions
// above at the level they were actually observed: in-browser behavior.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

interface JsdomModule {
  JSDOM: new (html: string, options?: { runScripts?: "dangerously" }) => { readonly window: unknown };
}

const { JSDOM } = createRequire(import.meta.url)("jsdom") as JsdomModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

// `jsdom` ships no bundled types and `@types/jsdom` is not installed (adding a
// dependency is owner-only territory here). These interfaces describe only
// the DOM surface this file actually drives, kept intentionally minimal
// rather than attempting a full ambient `lib.dom` shim.
interface MinimalDomEvent {
  preventDefault: () => void;
}

interface MinimalElement {
  checked: boolean;
  click: () => void;
  readonly dataset: Record<string, string | undefined>;
  readonly disabled: boolean;
  dispatchEvent: (event: MinimalDomEvent) => boolean;
  readonly hidden: boolean;
  readonly indeterminate: boolean;
  open: boolean;
  querySelector: (selector: string) => MinimalElement | null;
  querySelectorAll: (selector: string) => Iterable<MinimalElement>;
  readonly textContent: string | null;
  /** Present on inputs; the hidden decision-digest field is read through it. */
  value: string;
}

interface MinimalDocument {
  querySelector: (selector: string) => MinimalElement | null;
  querySelectorAll: (selector: string) => Iterable<MinimalElement>;
}

interface MinimalWindow {
  document: MinimalDocument;
  Event: {
    new (type: string, opts?: { bubbles?: boolean; cancelable?: boolean }): MinimalDomEvent;
    prototype: { preventDefault: () => void };
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function registerFixture(asUrl: string, fixtureName: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `fixtures/seed-manifests/${fixtureName}.json`), "utf8"));
  const canonical = canonicalConnectorKeyFromManifest(raw);
  const manifest = canonical && canonical !== raw.connector_id ? { ...raw, connector_id: canonical } : raw;
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${fixtureName}`);
  return manifest;
}

async function seedActiveFixtureBinding(manifest: Record<string, unknown>): Promise<void> {
  const connectorId = mustExist(
    typeof manifest.connector_id === "string" ? manifest.connector_id : null,
    "registered fixture must have a connector id"
  );
  const connectorInstanceId = `cin_picker_${connectorId}`;
  const now = new Date().toISOString();
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName: `${connectorId} picker fixture`,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function registerClient(asUrl: string): Promise<{ client_id: string }> {
  const resp = await fetch(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "Hosted MCP picker runtime client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
  return (await resp.json()) as { client_id: string };
}

interface CloseableTestServer {
  readonly asPort: number;
  readonly asServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
  readonly rsServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
}

function startOpenTestServer(): Promise<CloseableTestServer> {
  return startServer({ asPort: 0, dbPath: ":memory:", ownerAuthPassword: "", quiet: true, rsPort: 0 });
}

async function closeServer(server: CloseableTestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

// Boot the AS, register three connectors, seed two active owner bindings, and
// fetch the live picker HTML the way the browser would (GET /oauth/authorize
// with no authorization_details / connector_id). The unheld third catalog entry
// proves the picker filters registered sources through owner holdings. Returns a
// jsdom window with the inline picker script executed, plus helpers to drive and
// inspect it.
async function openPickerDom() {
  const server = await startOpenTestServer();
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const spotify = await registerFixture(asUrl, "spotify");
    const github = await registerFixture(asUrl, "github");
    await registerFixture(asUrl, "reddit");
    await seedActiveFixtureBinding(spotify);
    await seedActiveFixtureBinding(github);
    const client = await registerClient(asUrl);

    const verifier = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "runtime-state");
    authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const pickerResp = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(pickerResp.status, 200);
    const html = await pickerResp.text();

    // runScripts: 'dangerously' executes the inline picker <script>, wiring the
    // real event listeners the browser would. The IIFE also runs its initial
    // syncSource pass on load, exactly as in a browser.
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const window = dom.window as MinimalWindow;
    const { document } = window;
    const form = mustExist(document.querySelector("[data-hosted-mcp-picker-form]"), "picker form must render");

    const sources = () => Array.from(document.querySelectorAll("[data-hosted-mcp-source]"));
    const sourceBoxes = () => Array.from(document.querySelectorAll("[data-hosted-mcp-source-checkbox]"));
    const streamBoxes = () => Array.from(document.querySelectorAll("[data-hosted-mcp-stream-checkbox]"));
    const streamsIn = (source: MinimalElement) =>
      Array.from(source.querySelectorAll("[data-hosted-mcp-stream-checkbox]"));
    const sourceBoxIn = (source: MinimalElement) => source.querySelector("[data-hosted-mcp-source-checkbox]");
    const fire = (el: MinimalElement, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
    const click = (selector: string) => document.querySelector(selector)?.click();
    // Dispatch a cancelable submit and report whether the picker JS prevented it.
    const submit = () => {
      let prevented = false;
      const evt = new window.Event("submit", { bubbles: true, cancelable: true });
      const original = window.Event.prototype.preventDefault;
      evt.preventDefault = function patched(this: unknown) {
        prevented = true;
        original.call(this);
      };
      form.dispatchEvent(evt);
      return prevented;
    };
    const errorEl = () => form.querySelector("[data-hosted-mcp-picker-error]");
    // The approval binding is hashed with SubtleCrypto, so it lands a
    // microtask after the `change` that triggered it. A real click always
    // arrives long after; these tests drive the DOM synchronously, so they
    // wait for the field the way the page's own submit handler does.
    const decisionDigestField = () => form.querySelector("[data-hosted-mcp-decision-digest]");
    const awaitDecisionDigest = async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (decisionDigestField()?.value) {
          return decisionDigestField()?.value;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return decisionDigestField()?.value;
    };

    return {
      awaitDecisionDigest,
      click,
      decisionDigestField,
      async close() {
        await closeServer(server);
      },
      document,
      dom,
      errorEl,
      fire,
      form,
      server,
      sourceBoxes,
      sourceBoxIn,
      sources,
      streamBoxes,
      streamsIn,
      submit,
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

test("picker runtime: all sources render collapsed by default (no auto-expand)", async () => {
  const p = await openPickerDom();
  try {
    assert.ok(p.sources().length >= 2, "fixture should render at least two sources");
    assert.ok(
      p.sources().every((s) => !s.open),
      "no <details> source may start open"
    );
  } finally {
    await p.close();
  }
});

test("picker runtime: a registered source without an active owner binding does not render", async () => {
  const p = await openPickerDom();
  try {
    assert.equal(p.sources().length, 2, "only the two active owner bindings may render as picker sources");
  } finally {
    await p.close();
  }
});

test("picker runtime: nothing is selected on load (no phantom all-streams-selected)", async () => {
  const p = await openPickerDom();
  try {
    assert.ok(p.sourceBoxes().length >= 2 && p.streamBoxes().length >= 2, "render must contain pickable boxes");
    // After the IIFE's on-load syncSource pass, the human must see zero selection.
    assert.ok(
      p.sourceBoxes().every((b) => !b.checked),
      "no source checkbox may start checked"
    );
    assert.ok(
      p.sourceBoxes().every((b) => !b.indeterminate),
      "no source checkbox may start indeterminate"
    );
    assert.ok(
      p.streamBoxes().every((b) => !b.checked),
      "no stream checkbox may start checked"
    );
    assert.ok(
      p.sources().every((s) => s.dataset.sourceSelected === "false"),
      'every source must report data-source-selected="false"'
    );
  } finally {
    await p.close();
  }
});

test("picker runtime: a single stream can be selected without selecting the whole source", async () => {
  const p = await openPickerDom();
  try {
    const source = mustExist(p.sources()[0], "at least one source must render");
    const streams = p.streamsIn(source);
    assert.ok(streams.length >= 2, "need a multi-stream source for this assertion");

    // Check exactly one stream and fire its change event (a real user click).
    const firstStream = mustExist(streams[0], "at least one stream must render");
    firstStream.checked = true;
    p.fire(firstStream, "change");

    const checkedInSource = p.streamsIn(source).filter((s) => s.checked).length;
    assert.equal(checkedInSource, 1, "selecting one stream must NOT cascade to its siblings");

    const sourceBox = mustExist(p.sourceBoxIn(source), "the source checkbox must render");
    assert.equal(sourceBox.checked, true, "one selected stream marks its parent source selected");
    assert.equal(
      sourceBox.indeterminate,
      true,
      "a partial stream selection leaves the parent indeterminate, not fully checked"
    );
    assert.equal(source.dataset.sourceSelected, "true", "the source must report selected once a stream is checked");
  } finally {
    await p.close();
  }
});

test("picker runtime: toggling the source checkbox selects every stream (whole-source)", async () => {
  const p = await openPickerDom();
  try {
    const source = mustExist(p.sources()[0], "at least one source must render");
    const sourceBox = mustExist(p.sourceBoxIn(source), "the source checkbox must render");
    sourceBox.checked = true;
    p.fire(sourceBox, "change");

    const streams = p.streamsIn(source);
    assert.ok(streams.length > 0);
    assert.ok(
      streams.every((s) => s.checked),
      "checking the source must check all of its streams"
    );
    assert.equal(sourceBox.indeterminate, false, "a fully-selected source is not indeterminate");
  } finally {
    await p.close();
  }
});

test("picker runtime: an empty submit is blocked in-browser with an inline error (never a raw JSON path)", async () => {
  const p = await openPickerDom();
  try {
    const prevented = p.submit();
    assert.equal(prevented, true, "submitting with nothing selected must be prevented client-side");
    const err = mustExist(p.errorEl(), "an inline validation error must render");
    assert.ok(!err.hidden, "an inline validation error must be shown");
    assert.ok(
      mustExist(err.textContent, "error element must carry text").trim().length > 0,
      "the inline error must carry guidance text"
    );
  } finally {
    await p.close();
  }
});

test("picker runtime: a valid single-stream selection submits (not prevented)", async () => {
  const p = await openPickerDom();
  try {
    const stream = mustExist(
      mustExist(p.sources()[0], "at least one source must render").querySelector("[data-hosted-mcp-stream-checkbox]"),
      "the source must render a stream checkbox"
    );
    stream.checked = true;
    p.fire(stream, "change");
    await p.awaitDecisionDigest();

    // jsdom exposes no SubtleCrypto, which is the same situation as a browser
    // on a non-secure origin — a real case, since a local instance is reached
    // over plain HTTP. The picker must degrade rather than trap the owner:
    // the digest stays empty, nothing throws, and the submit is allowed
    // through on the retry so the SERVER's fail-closed check is what rejects
    // it (with a page telling the owner to review again), instead of a button
    // that silently does nothing forever.
    const digest = p.decisionDigestField()?.value ?? "";
    if (digest) {
      assert.match(digest, /^sha256:/, "a computed binding must be a sha256 digest");
    }
    p.submit();
    const prevented = p.submit();
    assert.equal(prevented, false, "a valid one-stream selection must never be trapped by the binding guard");
  } finally {
    await p.close();
  }
});

test("picker runtime: bulk controls behave distinctly (select / clear / expand / collapse)", async () => {
  const p = await openPickerDom();
  try {
    // Select all → every stream checked, every source selected.
    p.click("[data-hosted-mcp-select-sources]");
    assert.ok(
      p
        .streamBoxes()
        .filter((b) => !b.disabled)
        .every((b) => b.checked),
      "Select all must check every enabled stream"
    );

    // Clear all → nothing checked, but selection clearing must NOT silently
    // collapse rows the way Select all must NOT force them open. (Select all is
    // a selection action, not a disclosure action.)
    p.click("[data-hosted-mcp-clear-sources]");
    assert.ok(
      p.streamBoxes().every((b) => !b.checked),
      "Clear all must uncheck every stream"
    );
    assert.ok(
      p.sourceBoxes().every((b) => !b.checked),
      "Clear all must uncheck every source"
    );

    // Expand all / Collapse all are pure disclosure controls.
    p.click("[data-hosted-mcp-expand-all]");
    assert.ok(
      p.sources().every((s) => s.open),
      "Expand all must open every source"
    );
    p.click("[data-hosted-mcp-collapse-all]");
    assert.ok(
      p.sources().every((s) => !s.open),
      "Collapse all must close every source"
    );
  } finally {
    await p.close();
  }
});

test("picker runtime: the parent checkbox selects and clears its own source, with no per-source buttons", async () => {
  // The 54 per-source `Select every stream` / `Clear this source` buttons are
  // gone. They existed because 27 sources made bulk affordances feel
  // necessary, but the tri-state parent checkbox already does exactly this
  // job — and a control that needs two buttons to explain it is a control
  // that is not working. This proves the parent alone covers both directions.
  const p = await openPickerDom();
  try {
    const source = mustExist(p.sources()[0], "at least one source must render");
    assert.equal(
      source.querySelector("[data-hosted-mcp-clear-streams]"),
      null,
      "no per-source clear button remains"
    );
    assert.equal(
      source.querySelector("[data-hosted-mcp-select-streams]"),
      null,
      "no per-source select-every button remains"
    );

    const sourceBox = mustExist(p.sourceBoxIn(source), "the source checkbox must render");
    sourceBox.checked = true;
    p.fire(sourceBox, "change");
    assert.ok(
      p.streamsIn(source).every((s) => s.checked),
      "checking the parent selects every stream in that source"
    );
    assert.equal(source.open, true, "selecting a source opens it");
    assert.equal(source.dataset.sourceSelected, "true", "the source reads as selected");

    sourceBox.checked = false;
    p.fire(sourceBox, "change");
    assert.ok(
      p.streamsIn(source).every((s) => !s.checked),
      "unchecking the parent clears every stream in that source"
    );
    assert.equal(source.dataset.sourceSelected, "false", "the source reads as deselected");
  } finally {
    await p.close();
  }
});
