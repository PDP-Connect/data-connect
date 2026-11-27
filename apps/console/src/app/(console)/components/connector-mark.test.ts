// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createElement } from "react";
import * as React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorMark, isSingleColorConnectorIcon } from "./connector-mark.tsx";

Object.assign(globalThis, { React });

// Brief decision 5: single-colour marks must use the text-colour mask in both themes.
test("single-colour SVG marks are masked while multi-colour marks stay full colour", () => {
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg><path fill="#fff" d="M0 0"/></svg>' }), true);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg><path fill="#fff"/><path fill="#111"/></svg>' }), false);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg><path fill="#fff"/><path d="M0 0"/></svg>' }), false);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg><g fill="#fff"><path d="M0 0"/></g></svg>' }), true);
  // Brief decision 5: resolve inherited fill and stroke before deciding whether a mark has one colour.
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg fill="#fff"><g><path fill="inherit"/><circle fill="unset"/></g></svg>' }), true);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg stroke="#fff"><g><path fill="none" stroke="inherit"/></g></svg>' }), true);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg fill="#fff"><path fill="inherit"/><path fill="#111"/></svg>' }), false);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg><path style="fill:#fff"/></svg>' }), false);
  assert.equal(isSingleColorConnectorIcon({ kind: "inline_svg", svg: '<svg><path fill="url(#paint)"/></svg>' }), false);
  assert.equal(isSingleColorConnectorIcon(null), false);
  const whiteMark = renderToStaticMarkup(createElement(ConnectorMark, {
    connectorId: "mask-test",
    icon: { kind: "inline_svg", svg: '<svg viewBox="0 0 10 10"><path fill="#fff" d="M0 0h10v10H0z"/></svg>' },
    name: "Mask test",
  }));
  assert.match(whiteMark, /mask-image:/);
  assert.match(whiteMark, /bg-foreground/);
  const colorMark = renderToStaticMarkup(createElement(ConnectorMark, {
    connectorId: "color-test",
    icon: { kind: "inline_svg", svg: '<svg viewBox="0 0 10 10"><path fill="#fff"/><path fill="#111"/></svg>' },
    name: "Color test",
  }));
  assert.doesNotMatch(colorMark, /mask-image:/);
  assert.match(colorMark, /<svg/);

  // Brand tiles keep their declared background even when the glyph itself has one colour.
  const tiledMark = renderToStaticMarkup(createElement(ConnectorMark, {
    connectorId: "tiled-mask-test",
    icon: { backgroundColor: "#FF9900", kind: "inline_svg", svg: '<svg viewBox="0 0 10 10"><path fill="#fff" d="M0 0h10v10H0z"/></svg>' },
    name: "Tiled mask test",
  }));
  assert.doesNotMatch(tiledMark, /mask-image:/);
  assert.match(tiledMark, /background-color:#FF9900/i);
  assert.match(tiledMark, /fill="#fff"/i);
});
