// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COULDNT_REACH_BROWSER, plainBrowserTrouble } from "./browser-trouble-words.ts";

const VIEWER = fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url));

test("raw technical browser errors never reach the owner", () => {
  for (const raw of ["cdp websocket error", "WebSocket connection failed", "ECONNREFUSED 127.0.0.1:9222", "browser_surface_cdp_unreachable", "", null, undefined, "Error: socket hang up"]) {
    assert.equal(plainBrowserTrouble(raw), COULDNT_REACH_BROWSER, String(raw));
  }
});

// Round 7 review B3: a closed mapping. Only sentences DataConnect itself wrote are shown.
test("only authored sentences pass; any other text becomes the one generic sentence", () => {
  for (const raw of ["The browser could not start.", "Something odd happened with sk-live-abc123", "The server said no", "Timeout"]) {
    assert.equal(plainBrowserTrouble(raw), COULDNT_REACH_BROWSER, raw);
  }
  for (const known of ["The browser isn't available right now.", "This browser session expired. Try again.", "The browser could not start. Try again.", COULDNT_REACH_BROWSER]) {
    assert.equal(plainBrowserTrouble(known), known);
  }
});


test("the helper says what a lost browser means, offers Try again and hides Done", async () => {
  const src = await readFile(VIEWER, "utf8");
  // Every place a browser error text is drawn goes through the one function.
  assert.match(src, /plainBrowserTrouble\(message\)/);
  assert.match(src, /plainBrowserTrouble\(error\)/);
  assert.doesNotMatch(src, /Can't show the browser/);
  assert.match(src, /LOST_BROWSER_MEANS/);
  // The dock has no Done or Continue while the browser is lost.
  assert.match(src, /browserLost/);
  // A visible "Live" beside the dot, and a tooltip on the "…" button.
  assert.match(src, /title="More actions"/);
  assert.match(src, /visibleStatusLabel/);
});

// Closing judge, round 6 (F8, F10).
test("a lost browser's card keeps no sign-in instruction, and the round buttons say what they do in words", async () => {
  const src = await readFile(VIEWER, "utf8");
  const dock = src.slice(src.indexOf("Finish signing in"));
  assert.match(dock, /\{browserLost \? null : <p className="pdpp-caption text-muted-foreground">\{interactionStepLabel\(interactionKind, message\)\}<\/p>\}/);
  assert.match(dock, /\{browserLost \? null : <p className="pdpp-caption text-foreground">\{message\}<\/p>\}/);
  assert.match(src, /pdpp-stream-control-label">More</);
  assert.match(src, /pdpp-stream-control-label">Stop</);
});

test("the helper keeps a one-line DataConnect bar with the way back to the source", async () => {
  const src = await readFile(VIEWER, "utf8");
  assert.match(src, /data-testid="stream-way-back"/);
  assert.match(src, /← DataConnect/);
});

// Review B6.
test("a raw fetch failure from the browser is never shown or spoken", () => {
  for (const raw of ["Failed to fetch", "TypeError: Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "fetch failed"]) {
    assert.equal(plainBrowserTrouble(raw), COULDNT_REACH_BROWSER, raw);
  }
});

test("a failed remote-browser mount reaches the parent, hides Done, and Try again re-mints", async () => {
  const src = await readFile(VIEWER, "utf8");
  assert.match(src, /onMountFailure=\{\(message\) => onStatus\(\{ cause: "network", display: "trouble", troubleMessage: message \}\)\}/);
  assert.match(src, /onMountFailureRef\.current\?\.\(plainBrowserTrouble\(error\)\)/);
  assert.match(src, /onClick=\{\(\) => \{\s*if \(retryPlan\(errorKind\) === "new-session" && onRetry\) \{\s*onRetry\(\);\s*return;/);
  assert.match(src, /function submitInteraction\(data\?: Record<string, string>\) \{\s*if \(browserLost\) return;/);
});

// Round 7 review B2: a viewport problem is retried on the same session; only a lost or expired session mints a new one.
test("Try again re-applies the layout for a viewport failure and mints only for a lost or expired session", async () => {
  const words = (await import("./browser-trouble-words.ts")) as unknown as { retryPlan?: (kind: string) => string };
  const src = await readFile(VIEWER, "utf8");
  assert.match(src, /retryPlan\(errorKind\) === "new-session" && onRetry/);
  assert.match(src, /setErrorKind\("viewport"\)/);
  assert.match(src, /if \(error && errorKind === "mount"\) onMountFailureRef/);
  assert.equal(words.retryPlan?.("viewport"), "same-session");
  assert.equal(words.retryPlan?.("mount"), "new-session");
});

// Round 8 (F3 / s111): the error card sat on top of the instruction panel and the Stop control.
test("a lost browser replaces the instruction panel and leaves the corner Stop reachable", async () => {
  const src = await readFile(VIEWER, "utf8");
  assert.match(src, /\{!closeConfirmArmed && status\.display !== "trouble" \? <StreamInteractionDock/);
  assert.match(src, /<div aria-live="polite" className="pdpp-stream-toast-zone" data-slot="trouble">/);
  const css = await readFile(fileURLToPath(new URL("./stream.css", import.meta.url)), "utf8");
  assert.match(css, /\.pdpp-stream-toast-zone\[data-slot="trouble"\]\s*\{\s*--pdpp-stream-toast-offset: 4rem;/);
});

// Round 11 (F6): the status pill never wraps onto a second line.
test("the visible status pill does not wrap", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./stream-viewer.tsx", import.meta.url), "utf8");
  assert.match(source, /<span aria-hidden className="pdpp-caption whitespace-nowrap [^"]*">\{visibleStatusLabel/);
});
