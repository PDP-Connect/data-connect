// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for connector manifest `icon`.
 *
 * `icon` is an OPTIONAL, manifest-declared brand glyph the console renders in
 * place of the deterministic monogram fallback. v1 supports exactly one
 * kind, `inline_svg`: the manifest carries the SVG markup itself, so no
 * runtime fetch and no connector-id -> icon map exists anywhere in the
 * console or reference implementation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { validateManifestIcon } from "../server/connector-manifest-validation.ts";
import { startServer } from "../server/index.ts";
import { sanitizeSvg } from "../vendor/brand-react/src/sanitize-svg.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn: (harness: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface RegisterResult {
  body: ErrorBody | string | null;
  status: number;
}

function hasErrorBody(body: RegisterResult["body"]): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

async function registerConnectorManifest(asUrl: string, manifest: unknown): Promise<RegisterResult> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  let body: RegisterResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

const SIMPLE_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0z"/></svg>';

function makeManifest(extra: Record<string, unknown> = {}) {
  return {
    connector_id: "https://registry.pdpp.test/connectors/icon-fixture",
    display_name: "Icon fixture",
    protocol_version: "0.1.0",
    streams: [
      {
        cursor_field: "received_at",
        name: "notes",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            received_at: { format: "date-time", type: "string" },
          },
          required: ["id", "received_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
    ...extra,
  };
}

test("manifest declaring a valid inline_svg icon is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { color: "#1ED760", kind: "inline_svg", svg: SIMPLE_SVG } })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest omitting icon is accepted (no icon is the default state)", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest());
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest icon with an unsupported kind is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "remote_url", svg: SIMPLE_SVG } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.kind must be "inline_svg"/u);
  });
});

test("manifest icon.svg containing a script tag is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        icon: { kind: "inline_svg", svg: "<svg><script>alert(1)</script></svg>" },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.svg must be one bare <svg> element/u);
  });
});

test("manifest icon.svg with an event-handler attribute is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        icon: { kind: "inline_svg", svg: '<svg onload="alert(1)"><path d="M0 0z"/></svg>' },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.svg must be one bare <svg> element/u);
  });
});

test("manifest icon.svg not wrapped in a bare <svg> element is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "inline_svg", svg: "<div>not an svg</div>" } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.svg must be one bare <svg> element/u);
  });
});

test("manifest icon.svg whose root is not <svg> is rejected even when every element is allowlisted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "inline_svg", svg: '<path d="M0 0z"/>' } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.svg must be one bare <svg> element/u);
  });
});

test("manifest icon.color with a non-hex value is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { color: "spotify green", kind: "inline_svg", svg: SIMPLE_SVG } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.color must be a hex color/u);
  });
});

test("manifest icon with unsupported keys is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "inline_svg", svg: SIMPLE_SVG, url: "https://example.com/icon.svg" } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon has unsupported keys/u);
  });
});

test("validateManifestIcon: pure-function shape checks", () => {
  assert.doesNotThrow(() => validateManifestIcon({}, "invalid_request"));
  assert.doesNotThrow(() => validateManifestIcon({ icon: undefined }, "invalid_request"));
  assert.doesNotThrow(() => validateManifestIcon({ icon: { kind: "inline_svg", svg: SIMPLE_SVG } }, "invalid_request"));
  assert.throws(() => validateManifestIcon({ icon: "not-an-object" }, "invalid_request"));
  assert.throws(() => validateManifestIcon({ icon: { kind: "inline_svg" } }, "invalid_request"));
});

// ---------------------------------------------------------------------------
// XSS vector table — the acceptance gate for the allowlist rewrite.
//
// All nine rows are known SVG XSS delivery vectors. Before the allowlist
// rewrite (a denylist matching only <script> and on<event>= attributes), the
// first two were blocked and the remaining seven reached dangerouslySetInnerHTML
// unmodified — confirmed by running this exact table against the pre-fix
// validator (see docs/inbox/report-icon-svg-xss.md for the before/after run).
// ---------------------------------------------------------------------------

const XSS_VECTORS: ReadonlyArray<{ name: string; svg: string }> = [
  { name: "plain <script>", svg: "<svg><script>alert(1)</script></svg>" },
  { name: "<svg onload=...>", svg: '<svg onload="alert(1)"><path d="M0 0z"/></svg>' },
  {
    name: '<foreignObject><iframe src="javascript:...">',
    svg: '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
  },
  {
    name: '<a xlink:href="javascript:...">',
    svg: '<svg><a xlink:href="javascript:alert(1)"><path d="M0 0z"/></a></svg>',
  },
  {
    name: '<use href="https://evil.example/x.svg#p"> (external fetch)',
    svg: '<svg><use href="https://evil.example/x.svg#p"/></svg>',
  },
  { name: '<image href="javascript:...">', svg: '<svg><image href="javascript:alert(1)"/></svg>' },
  {
    name: '<animate attributeName="href" values="javascript:...">',
    svg: '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
  },
  {
    name: '<set attributeName="xlink:href" to="javascript:...">',
    svg: '<svg><a><set attributeName="xlink:href" to="javascript:alert(1)"/></a></svg>',
  },
  {
    name: '<style>*{background:url("javascript:...")}</style>',
    svg: '<svg><style>*{background:url("javascript:alert(1)")}</style></svg>',
  },
];

for (const vector of XSS_VECTORS) {
  test(`icon.svg XSS vector rejected: ${vector.name}`, async () => {
    await withHarness(async ({ asUrl }) => {
      const { status, body } = await registerConnectorManifest(
        asUrl,
        makeManifest({ icon: { kind: "inline_svg", svg: vector.svg } })
      );
      assert.equal(status, 400, `expected vector to be rejected, got ${status}: ${JSON.stringify(body)}`);
      assert.ok(hasErrorBody(body));
    });
  });
}

// Shape-only glyphs representative of the two currently-shipping manifest
// icons (slack, steam) — brand-color paths/circles/strokes, nothing else.
// These prove the allowlist does not regress real icon rendering.
const SLACK_SHAPED_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 15a2 2 0 1 1 2 2H5v-2z" fill="#36C5F0"/><path d="M9 5a2 2 0 1 1 2-2v2H9z" fill="#2EB67D"/></svg>';
const STEAM_SHAPED_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#171A21"/><path d="M6 12h4l2-4h4" stroke="#66C0F4" stroke-width="2" fill="none"/></svg>';

test("manifest icon shaped like the shipping slack icon still validates", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { color: "#36C5F0", kind: "inline_svg", svg: SLACK_SHAPED_SVG } })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest icon shaped like the shipping steam icon still validates", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { color: "#171A21", kind: "inline_svg", svg: STEAM_SHAPED_SVG } })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("validateManifestIcon: allowlist rejects disallowed elements/attributes/values directly", () => {
  for (const vector of XSS_VECTORS) {
    assert.throws(
      () => validateManifestIcon({ icon: { kind: "inline_svg", svg: vector.svg } }, "invalid_request"),
      `expected vector to throw: ${vector.name}`
    );
  }
  assert.throws(() =>
    validateManifestIcon({ icon: { kind: "inline_svg", svg: `<svg>${"x".repeat(20_000)}</svg>` } }, "invalid_request")
  );
  assert.doesNotThrow(() =>
    validateManifestIcon({ icon: { kind: "inline_svg", svg: SLACK_SHAPED_SVG } }, "invalid_request")
  );
  assert.doesNotThrow(() =>
    validateManifestIcon({ icon: { kind: "inline_svg", svg: STEAM_SHAPED_SVG } }, "invalid_request")
  );
});

// ---------------------------------------------------------------------------
// One allowlist. The console renders a manifest icon only if sanitizeSvg
// (vendor/brand-react, the function behind validatedConnectorIcon) accepts it.
// The server must therefore accept exactly what that function accepts: an icon
// the server stores but the console drops silently shows a monogram, and an
// icon the server rejects but the console would render is a second list to
// keep in step. Every row below was decided differently by the two old lists.
// ---------------------------------------------------------------------------

const VERDICT_CASES: ReadonlyArray<{ name: string; svg: string }> = [
  {
    name: "root with role and aria-hidden",
    svg: '<svg role="img" aria-hidden="true" viewBox="0 0 24 24"><path d="M0 0z"/></svg>',
  },
  { name: "<defs> wrapper", svg: '<svg viewBox="0 0 24 24"><defs><path d="M0 0z"/></defs></svg>' },
  { name: "duplicate attribute", svg: '<svg viewBox="0 0 24 24"><path d="M0 0z" d="M1 1z"/></svg>' },
  { name: "character reference in a value", svg: '<svg viewBox="0 0 24 24"><path d="M0 0z" fill="&#35;fff"/></svg>' },
  { name: "backslash escape in a value", svg: '<svg viewBox="0 0 24 24"><path d="M0 0z" fill="\\23fff"/></svg>' },
  { name: "unclosed group", svg: '<svg viewBox="0 0 24 24"><g><path d="M0 0z"/></svg>' },
  { name: "stray closing tag", svg: '<svg viewBox="0 0 24 24"></g><path d="M0 0z"/></svg>' },
  { name: "mismatched closing tag", svg: '<svg viewBox="0 0 24 24"><g><path d="M0 0z"/></svg></g>' },
  { name: "two roots", svg: '<svg><path d="M0 0z"/></svg><svg><path d="M0 0z"/></svg>' },
  { name: "text after the root", svg: '<svg viewBox="0 0 24 24"><path d="M0 0z"/></svg>trailing' },
  { name: "title caption", svg: '<svg viewBox="0 0 24 24"><title>Mark</title><path d="M0 0z"/></svg>' },
  { name: "single-quoted attributes", svg: "<svg viewBox='0 0 24 24'><path d='M0 0z'/></svg>" },
  { name: "closing tag with attributes", svg: '<svg viewBox="0 0 24 24"><g><path d="M0 0z"/></g fill="red"></svg>' },
  { name: "self-closing root", svg: '<svg viewBox="0 0 24 24"/>' },
  { name: "url() in a value", svg: '<svg viewBox="0 0 24 24"><path d="M0 0z" fill="url(#a)"/></svg>' },
  { name: "mixed-case element and attribute names", svg: '<SVG ViewBox="0 0 24 24"><PATH D="M0 0z"/></SVG>' },
  ...XSS_VECTORS,
];

function serverAccepts(svg: string): boolean {
  try {
    validateManifestIcon({ icon: { kind: "inline_svg", svg } }, "invalid_request");
    return true;
  } catch {
    return false;
  }
}

for (const { name, svg } of VERDICT_CASES) {
  test(`server validator and console sanitizer give one verdict: ${name}`, () => {
    const console = sanitizeSvg(svg) !== null;
    assert.equal(serverAccepts(svg), console, `console sanitizer ${console ? "accepts" : "rejects"} this SVG`);
  });
}
