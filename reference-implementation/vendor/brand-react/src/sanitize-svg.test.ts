// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSvg } from "./sanitize-svg.ts";

test("accepts a minimal bare svg", () => {
  assert.equal(
    sanitizeSvg('<svg viewBox="0 0 24 24"><path d="M1 2" /></svg>'),
    '<svg viewBox="0 0 24 24"><path d="M1 2" /></svg>'
  );
});

test("accepts our shipped-manifest shape (aria-hidden, fill on root)", () => {
  const svg =
    '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M1 2" /></svg>';
  assert.equal(sanitizeSvg(svg), svg);
});

test("accepts the simple-icons shape (role, title)", () => {
  const svg =
    '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>GitHub</title><path d="M1 2"/></svg>';
  assert.equal(sanitizeSvg(svg), svg);
});

test("rejects a script element", () => {
  assert.equal(sanitizeSvg("<svg><script>alert(1)</script></svg>"), null);
});

test("rejects an event-handler attribute", () => {
  assert.equal(sanitizeSvg('<svg onload="alert(1)"><path d="M1 2" /></svg>'), null);
});

test("rejects an external reference via image href", () => {
  assert.equal(sanitizeSvg('<svg><image href="https://evil.test/x.png" /></svg>'), null);
});

test("rejects a javascript: or data: or url() attribute value", () => {
  assert.equal(sanitizeSvg('<svg fill="url(javascript:alert(1))"><path d="M1 2" /></svg>'), null);
});

test("rejects a disallowed element", () => {
  assert.equal(sanitizeSvg("<svg><foreignObject><div>x</div></foreignObject></svg>"), null);
});

test("rejects markup without a bare svg root", () => {
  assert.equal(sanitizeSvg('<g><path d="M1 2" /></g>'), null);
});

test("rejects non-SVG text", () => {
  assert.equal(sanitizeSvg("just some text, not markup"), null);
});

test("rejects empty content", () => {
  assert.equal(sanitizeSvg(""), null);
  assert.equal(sanitizeSvg("   "), null);
});

test("rejects oversized content", () => {
  const huge = `<svg>${'<path d="M1 2" />'.repeat(1000)}</svg>`;
  assert.equal(sanitizeSvg(huge), null);
});

test("rejects browser-significant duplicate and character-encoded attributes", () => {
  const unsafe = [
    '<svg fill="url(https://example.invalid/x)" fill="#fff"></svg>',
    '<svg FILL="url(https://example.invalid/x)" fill="#fff"></svg>',
    '<svg fill="&#117;rl(https://example.invalid/x)"></svg>',
    '<svg fill="&#x75;rl(https://example.invalid/x)"></svg>',
    '<svg fill="data&#58;image/svg+xml,test"></svg>',
    '<svg fill="javascript&#58;alert(1)"></svg>',
  ];
  for (const svg of unsafe) {
    assert.equal(sanitizeSvg(svg), null, svg);
  }
});

test("requires exactly one balanced SVG root", () => {
  for (const svg of ["<svg></svg><svg></svg>", "<svg><g></svg>", "<svg>", "prefix<svg/>", "<svg/>suffix"]) {
    assert.equal(sanitizeSvg(svg), null, svg);
  }
  assert.equal(sanitizeSvg('<svg><g><path d="M1 2"/></g></svg>'), '<svg><g><path d="M1 2"/></g></svg>');
});

test("rejects CSS escapes before a presentation attribute reaches the browser", () => {
  const escaped = [
    String.raw`<svg fill="u\72l(https://example.invalid/x)"></svg>`,
    String.raw`<svg fill="U\000052 L(https://example.invalid/x)"></svg>`,
  ];
  for (const svg of escaped) {
    assert.equal(sanitizeSvg(svg), null, svg);
  }
});

// No shipped or simple-icons mark uses <defs>, and its only useful children
// (gradients, clip paths) are not allowed elements, so it stays out.
test("rejects <defs>", () => {
  assert.equal(sanitizeSvg('<svg viewBox="0 0 24 24"><defs><path d="M0 0z"/></defs></svg>'), null);
});
