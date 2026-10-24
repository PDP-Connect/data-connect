// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorIcon has zero connector-specific knowledge: it renders exactly
 * what its `icon`/`name` props carry. These tests prove the fallback
 * (monogram) path, the manifest-declared inline_svg path, and that an
 * unrecognized icon.kind degrades to the fallback rather than throwing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { brandTileColors, ConnectorIcon } from "./connector-icon.tsx";

const MONOGRAM_CLASS = /class="pdpp-monogram pdpp-monogram--tinted"/;
const ARIA_HIDDEN_TRUE = /aria-hidden="true"/;
const SPOTIFY_INITIALS_DATA = /data-initials="SP"/;
const HUE_VAR_RE = /--pdpp-monogram-hue:\s*(-?\d+)/;
const ICON_CLASS = /class="pdpp-connector-icon"/;
const SVG_VIEWBOX = /viewBox="0 0 24 24"/;
const SVG_COLOR_STYLE = /color:#1ED760/;

test("ConnectorIcon with no icon renders the deterministic monogram fallback", () => {
  const html = renderToStaticMarkup(createElement(ConnectorIcon, { name: "Spotify" }));
  assert.match(html, MONOGRAM_CLASS);
  assert.match(html, ARIA_HIDDEN_TRUE);
  assert.match(html, SPOTIFY_INITIALS_DATA);
});

test("ConnectorIcon fallback is deterministic across renders for the same name", () => {
  const first = renderToStaticMarkup(createElement(ConnectorIcon, { name: "Notion" }));
  const second = renderToStaticMarkup(createElement(ConnectorIcon, { name: "Notion" }));
  assert.equal(first, second);
});

test("ConnectorIcon fallback derives distinct hues for distinct names", () => {
  const a = renderToStaticMarkup(createElement(ConnectorIcon, { icon: undefined, name: "GitHub" }));
  const b = renderToStaticMarkup(createElement(ConnectorIcon, { icon: undefined, name: "Reddit" }));
  const hueOf = (html: string) => html.match(HUE_VAR_RE)?.[1];
  assert.notEqual(hueOf(a), hueOf(b));
});

test("ConnectorIcon renders a manifest-declared inline_svg icon verbatim", () => {
  const svg = '<svg role="img" viewBox="0 0 24 24"><path d="M12 0z"/></svg>';
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { icon: { color: "#1ED760", kind: "inline_svg", svg }, name: "Spotify" })
  );
  assert.match(html, ICON_CLASS);
  assert.doesNotMatch(html, MONOGRAM_CLASS);
  assert.match(html, SVG_VIEWBOX);
  assert.match(html, SVG_COLOR_STYLE);
});

test("ConnectorIcon falls back to the monogram for an unrecognized icon.kind", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { icon: { kind: "remote_url", svg: "irrelevant" }, name: "Slack" })
  );
  assert.match(html, MONOGRAM_CLASS);
});

test("ConnectorIcon falls back to the monogram when icon.svg is empty", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { icon: { kind: "inline_svg", svg: "" }, name: "Slack" })
  );
  assert.match(html, MONOGRAM_CLASS);
});

const WHITE_GLYPH_SVG = '<svg role="img" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M12 0z"/></svg>';

test("ConnectorIcon draws a tile in the brand colour so a white glyph stays visible on a light card", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, {
      icon: { background: "#FC4C02", kind: "inline_svg", svg: WHITE_GLYPH_SVG },
      name: "Strava",
    })
  );
  assert.match(html, /class="pdpp-connector-icon pdpp-connector-icon--tile"/);
  assert.match(html, /background:#fc4c02/);
  assert.match(html, /--pdpp-connector-glyph:#ffffff/);
});

test("ConnectorIcon switches to a dark glyph when the brand colour is light", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, {
      icon: { background: "#FFFC00", kind: "inline_svg", svg: WHITE_GLYPH_SVG },
      name: "Snapchat",
    })
  );
  assert.match(html, /--pdpp-connector-glyph:#111111/);
});

test("brandTileColors accepts only plain hex colours, so a manifest value cannot inject style", () => {
  assert.deepEqual(brandTileColors("#369"), { background: "#336699", glyph: "#ffffff" });
  assert.equal(brandTileColors("red"), null);
  assert.equal(brandTileColors("#fff; background:url(x)"), null);
  assert.equal(brandTileColors("javascript:alert(1)"), null);
  assert.equal(brandTileColors(null), null);
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, {
      icon: { background: "red;position:fixed", kind: "inline_svg", svg: WHITE_GLYPH_SVG },
      name: "Odd",
    })
  );
  assert.doesNotMatch(html, /position:fixed/);
  assert.doesNotMatch(html, /--tile/);
});
