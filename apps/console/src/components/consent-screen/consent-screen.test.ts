// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the console's consent screen.
 *
 * Two kinds of guarantee live here:
 *
 *  1. STRUCTURAL — the page is gated, the components are the real shared ones,
 *     the CSS is token-only. These read the source text, the same idiom the
 *     retired design-preview tests used, because the console's test runner has
 *     no DOM.
 *
 *  2. CONTRACT — the console's `ConsentScreenModel` and the authorization
 *     server's `HostedMcpConsentChallengeModel` describe the same JSON. This
 *     is the one that would otherwise rot silently: a field the server renames
 *     would read as `undefined` here with no type error anywhere, because the
 *     two are joined by an HTTP boundary, not by an import.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clientPublishedLinks, sourceAccountLabel } from "./consent-screen-model.ts";

const COMPONENT_DIR = fileURLToPath(new URL(".", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../../app/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const CLIENT_SOURCE = readFileSync(join(COMPONENT_DIR, "consent-screen-client.tsx"), "utf8");
const CSS_SOURCE = readFileSync(join(COMPONENT_DIR, "consent-screen.module.css"), "utf8");
const MODEL_SOURCE = readFileSync(join(COMPONENT_DIR, "consent-screen-model.ts"), "utf8");
const PAGE_SOURCE = readFileSync(join(APP_DIR, "consent", "page.tsx"), "utf8");
const ACTIONS_SOURCE = readFileSync(join(APP_DIR, "consent", "actions.ts"), "utf8");
const AS_HELPERS_SOURCE = readFileSync(
  join(REPO_ROOT, "reference-implementation", "server", "routes", "as-consent-ui-helpers.ts"),
  "utf8"
);

test("a repeated source name is stripped from the account label", () => {
  assert.equal(sourceAccountLabel("Amazon", "Amazon - gezalsatx@gmail.com"), "gezalsatx@gmail.com");
  assert.equal(sourceAccountLabel("Apple Contacts", "Apple Contacts - tim@opendatalabs.com"), "tim@opendatalabs.com");
  assert.equal(sourceAccountLabel("ChatGPT", "chaka.dondo@gmail.com"), "chaka.dondo@gmail.com");
});

test("client metadata line has both, one, and no published links", () => {
  assert.deepEqual(clientPublishedLinks([
    { href: "https://client.example/privacy", label: "Privacy policy" },
    { href: "https://client.example/terms", label: "Terms of service" },
  ]), [
    { href: "https://client.example/privacy", label: "Privacy policy" },
    { href: "https://client.example/terms", label: "Terms" },
  ]);
  assert.deepEqual(clientPublishedLinks([{ href: "https://client.example/privacy", label: "Privacy policy" }]), [
    { href: "https://client.example/privacy", label: "Privacy policy" },
  ]);
  assert.deepEqual(clientPublishedLinks([]), []);
  assert.match(CLIENT_SOURCE, /No privacy policy or terms published\./);
});

// ─── Owner gating ───────────────────────────────────────────────────────────

test("the consent page calls the real DAL owner-session gate", () => {
  assert.match(PAGE_SOURCE, /await verifyDashboardSession\(/, "must actually call the gate, not just import it");
  assert.match(
    PAGE_SOURCE,
    /from ["']@\/app\/\(console\)\/lib\/verify-session\.ts["']/,
    "must import the console's real verify-session module, not a reimplementation"
  );
});

test("an unauthenticated visitor returns to the SAME challenge after login", () => {
  // The whole point of the returnTo: a login round trip that lands on the
  // dashboard strands the client's authorize request forever.
  assert.match(
    PAGE_SOURCE,
    /verifyDashboardSession\(\s*challenge\s*\?\s*`\/consent\?challenge=\$\{encodeURIComponent\(challenge\)\}`/,
    "the session gate must be given a returnTo carrying the challenge id"
  );
});

test("both server actions re-verify the owner session themselves", () => {
  // A Server Action is independently reachable — it does not inherit the
  // page's gate. This is the CVE-2025-29927 class the DAL pattern exists for.
  assert.match(ACTIONS_SOURCE, /await verifyDashboardSession\(\)/, "the shared POST helper must verify the session");
});

test("the consent page and its actions are server-only, never cached", () => {
  assert.match(PAGE_SOURCE, /export const dynamic = "force-dynamic"/, "a single-use challenge must not be cached");
  assert.match(PAGE_SOURCE, /robots:\s*\{[^}]*index:\s*false/, "a consent decision must never be indexed");
  assert.match(ACTIONS_SOURCE, /^"use server";$/m, "actions module must be a Server Actions module");
  for (const source of [PAGE_SOURCE, ACTIONS_SOURCE]) {
    assert.match(source, /cache:\s*"no-store"/, "every challenge fetch must bypass the cache");
  }
});

// ─── The approval artifact (AS-conformance #15) ────────────────────────────

test("the decision digest is computed by the console, from the reference implementation's own function", () => {
  // The digest binds what THIS SURFACE DISPLAYED. Computed server-side by the
  // AS it would bind nothing, because the AS would only be comparing its own
  // arithmetic against itself. Importing the shared function (rather than
  // reimplementing SHA-256 over a hand-rolled canonical form) is what keeps
  // the two sides byte-identical.
  assert.match(
    ACTIONS_SOURCE,
    /import \{ computeHostedMcpDecisionDigest \} from "pdpp-reference-implementation\/hosted-mcp-decision-digest"/,
    "must use the reference implementation's digest function, not a second implementation"
  );
  assert.match(ACTIONS_SOURCE, /decision_digest: decisionDigest/, "the computed digest must be sent");
  assert.doesNotMatch(ACTIONS_SOURCE, /createHash|sha256/i, "must not hand-roll the digest");
});

test("the review digest is echoed unchanged, never recomputed by the console", () => {
  // The review digest is the AS's statement about the eligibility snapshot.
  // A console that recomputed it could only ever agree with itself, defeating
  // the stale-review check.
  assert.match(ACTIONS_SOURCE, /review_digest: decision\.reviewDigest/);
  assert.match(CLIENT_SOURCE, /reviewDigest: model\.reviewDigest/, "the screen echoes the model's digest verbatim");
});

test("the digest covers the client identity the screen displayed", () => {
  assert.match(ACTIONS_SOURCE, /clientId,/, "the digest must bind the client");
  assert.match(PAGE_SOURCE, /const clientId = model\.client\.id/, "the client id comes from the challenge model");
});

// ─── Zero drift: the real shared component system ──────────────────────────

test("the consent screen uses the real @pdpp/brand-react component modules", () => {
  assert.match(CLIENT_SOURCE, /from ["']@pdpp\/brand-react["']/);
  for (const component of ["ConnectorIcon", "Endorse", "IcButton", "IcInput"]) {
    assert.ok(new RegExp(`\\b${component}\\b`).test(CLIENT_SOURCE), `must use the real ${component}`);
  }
  assert.match(CLIENT_SOURCE, /className="pdpp-sheet"/, "Terms box must use the real neutral sheet surface");
});

test("the consent screen carries the console's own theme control", () => {
  // Same component and same persisted next-themes choice the console sidebar
  // uses, so a theme chosen anywhere in the console is honored here on load.
  assert.match(
    CLIENT_SOURCE,
    /import \{ ThemeToggle \} from "@\/components\/theme\/theme-toggle\.tsx"/,
    "must import the console's ThemeToggle, the same one the sidebar renders"
  );
  assert.match(CLIENT_SOURCE, /<ThemeToggle \/>/, "must render the toggle");
});

test("connector icons come from the manifest, never a page-local asset directory", () => {
  // ConnectorIcon renders the manifest's own `icon` declaration and falls back
  // to its Monogram. A connector-id -> file map anywhere would mean a
  // connector the console has never heard of renders worse than one it has.
  assert.match(CLIENT_SOURCE, /<ConnectorIcon icon=\{source\.icon \?\? null\}/, "icon must come from the source model");
  assert.doesNotMatch(CLIENT_SOURCE, /readFileSync|\.svg["']/, "must not read icon assets from disk");
  assert.equal(existsSync(join(COMPONENT_DIR, "icons")), false, "no page-local icon directory may exist");
});

test("no hosted-ui-* class strings appear anywhere in the consent screen source", () => {
  for (const [name, source] of [
    ["client component", CLIENT_SOURCE],
    ["layout CSS", CSS_SOURCE],
    ["page", PAGE_SOURCE],
  ] as const) {
    assert.doesNotMatch(source, /hosted-ui-/, `${name} must not reference the retired hosted-ui.ts vocabulary`);
  }
});

test("layout CSS defines no hardcoded color literals — every color is a var(--token) reference", () => {
  const colorProperty = /(?:^|;|\{)\s*(?:background|color|border(?:-\w+)?)\s*:\s*([^;]+);/gm;
  const offenders: string[] = [];
  let match: RegExpExecArray | null = colorProperty.exec(CSS_SOURCE);
  while (match) {
    const value = (match[1] ?? "").trim();
    if (/#[0-9a-fA-F]{3,8}\b/.test(value) || /\b(?:rgb|rgba|hsl|hsla)\(/.test(value)) {
      offenders.push(value);
    }
    for (const literal of value.match(/oklch\([^)]*\)/g) ?? []) {
      if (!/var\(--/.test(value)) {
        offenders.push(literal);
      }
    }
    match = colorProperty.exec(CSS_SOURCE);
  }
  assert.deepEqual(offenders, [], "every color must reference a design token");
});

test("client trust explanations live only in an accessible chip hint", () => {
  assert.doesNotMatch(CLIENT_SOURCE, /What was checked/);
  assert.doesNotMatch(CLIENT_SOURCE, /<details className=\{styles\.trustDetails\}/);
  assert.match(CLIENT_SOURCE, /<IcTooltip>/, "desktop hover and focus use the shared tooltip primitive");
  assert.match(CLIENT_SOURCE, /<IcPopover>/, "touch uses a dismissible, anchored shared popover");
  assert.match(CLIENT_SOURCE, /role="dialog"/, "the tappable explanation is announced as an interactive popover");
  assert.match(CLIENT_SOURCE, /Dismiss trust explanation/, "the touch popover has an explicit dismiss control");
});

test("client trust chip copy names only the completed check", () => {
  assert.doesNotMatch(CLIENT_SOURCE, /Its identity document was fetched from/);
  assert.doesNotMatch(CLIENT_SOURCE, /Its name and logo come from its own registration/);
  assert.doesNotMatch(CLIENT_SOURCE, /The operator of this server has confirmed the app/);
  assert.match(CLIENT_SOURCE, /Name and logo are self-reported\. Nothing was verified\./);
  assert.match(
    CLIENT_SOURCE,
    /Verified automatically against the identity document published at \$\{client\.domain\}\. No manual review\./
  );
  assert.match(CLIENT_SOURCE, /Confirmed by the operator of this server\./);
});

test("client metadata links render only when the challenge model supplies them", () => {
  assert.match(
    CLIENT_SOURCE,
    /publishedLinks\.length > 0/,
    "an absent policy_uri/tos_uri pair must omit the secondary row"
  );
  assert.match(
    CLIENT_SOURCE,
    /publishedLinks\.map\(\(link, index\) =>[\s\S]*?href=\{link\.href\}[\s\S]*?target="_blank"/,
    "each present resolved metadata link must remain a direct, new-tab link"
  );
  assert.match(
    CLIENT_SOURCE,
    /rel="noopener noreferrer nofollow"/,
    "new-tab metadata links must not retain an opener"
  );
});

test("field panels expose bulk selection while preserving required fields", () => {
  assert.match(CLIENT_SOURCE, /Select all/);
  assert.match(CLIENT_SOURCE, /Select none/);
  assert.match(CLIENT_SOURCE, /selectAll \|\| field\.required/);
  assert.match(CLIENT_SOURCE, /disabled=\{field\.required\}/);
});

test("described fields show description first and raw names as mono hints", () => {
  assert.match(CLIENT_SOURCE, /field\.description \|\| field\.name/);
  assert.match(CLIENT_SOURCE, /className=\{styles\.fieldRaw\}>\{field\.name\}<\/span>/);
});

// ─── The client/server model contract ──────────────────────────────────────

/** Field names declared on an interface block, by interface name. */
function declaredFields(source: string, interfaceName: string): string[] {
  const start = source.indexOf(`interface ${interfaceName} {`);
  assert.notEqual(start, -1, `interface ${interfaceName} must exist`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  // Top-level `readonly name:` / `name:` declarations, ignoring nested blocks
  // by requiring the declaration to sit at the interface's own indent.
  return [...body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_][\w]*)[?]?:/gm)].map((m) => m[1] as string).sort();
}

test("the console's ConsentScreenModel matches the AS's HostedMcpConsentChallengeModel field-for-field", () => {
  // The two are joined by an HTTP boundary, so nothing else would catch a
  // rename: the console would simply read `undefined` and render a blank.
  const consoleFields = declaredFields(MODEL_SOURCE, "ConsentScreenModel");
  const serverFields = declaredFields(AS_HELPERS_SOURCE, "HostedMcpConsentChallengeModel");
  assert.ok(serverFields.length >= 8, "vacuity guard: the server model must actually declare fields");
  assert.deepEqual(
    consoleFields,
    serverFields,
    "the console model and the AS challenge model must declare the same top-level fields"
  );
});

test("every field the consent screen reads off a stream exists on the AS model", () => {
  // Catches the narrower rot the field-set test above cannot: a stream field
  // the screen reads that the server never sends.
  const streamFields = declaredFields(MODEL_SOURCE, "ConsentStreamModel");
  for (const field of ["fields", "fieldsTotal", "id", "label", "name", "selected", "selectionValue", "sentence", "timePhrase"]) {
    assert.ok(streamFields.includes(field), `ConsentStreamModel must declare ${field}`);
    assert.ok(
      new RegExp(`readonly ${field}[?]?:`).test(AS_HELPERS_SOURCE),
      `the AS challenge model must declare stream field ${field}`
    );
  }
});

// ─── Consent is an affirmative act ─────────────────────────────────────────

test("the screen takes its initial selection from the server, never defaulting anything on itself", () => {
  // The picker pre-selects nothing. Whether that stays true is a SERVER
  // policy; this asserts the console does not invent a default of its own.
  assert.match(
    CLIENT_SOURCE,
    /streamState\[stream\.name\] = stream\.selected;/,
    "initial selection must come from the model's own `selected` flag"
  );
  assert.doesNotMatch(CLIENT_SOURCE, /=\s*true;?\s*\/\/ default/i, "no client-side default-on");
});

test("Allow is disabled until the owner has chosen something", () => {
  assert.match(CLIENT_SOURCE, /const nothingChosen = counts\.selectedStreamCount === 0/);
  assert.match(CLIENT_SOURCE, /disabled=\{busy \|\| nothingChosen\}/, "Allow must be disabled with an empty selection");
});

test("a source with no chosen streams is not submitted as a grant", () => {
  // Submitting a checked-but-empty source would make the AS reject the whole
  // approval for an empty stream set — a confusing failure for a decision the
  // owner expressed perfectly clearly.
  assert.match(CLIENT_SOURCE, /\.filter\(\(source\) => source\.streamNames\.length > 0\)/);
});

test("the owner's refusal is a first-class action beside Allow", () => {
  assert.match(CLIENT_SOURCE, /rejectAction\(\)/, "Cancel must call the reject action");
  assert.match(CLIENT_SOURCE, /variant="ghost"/, "Cancel renders as a real secondary action, not a link");
});

test("a completed decision navigates to the client and leaves no back-button replay", () => {
  assert.match(
    CLIENT_SOURCE,
    /window\.location\.replace\(redirectUrl\)/,
    "must replace, so Back cannot re-present a consumed challenge"
  );
});

test("a failed submission tells the owner nothing was shared", () => {
  assert.match(CLIENT_SOURCE, /setSubmitError/, "failures must surface to the owner");
  assert.match(CLIENT_SOURCE, /role="alert"/, "the failure must be announced, not just drawn");
  assert.match(ACTIONS_SOURCE, /Nothing was shared/, "the fallback message must state the outcome");
});

// ─── The retired preview is gone ───────────────────────────────────────────

test("the design-consent-preview route no longer exists — the real page is the design", () => {
  assert.equal(
    existsSync(join(APP_DIR, "design-consent-preview")),
    false,
    "the mock preview must be deleted; /consent is the only consent surface"
  );
});

// ─── The data time range reaches the wire ──────────────────────────────────
//
// The defect these lock: the date controls held state and the submission
// dropped it, so an owner who narrowed a stream to 2025 got a grant covering
// every year. The controls were live and the wire was not.

test("the owner's per-stream date range is submitted, not just collected", () => {
  assert.match(CLIENT_SOURCE, /streamRanges,/, "buildDecision must return the ranges it tracked");
  assert.match(
    ACTIONS_SOURCE,
    /stream_range: decision\.streamRanges/,
    "the accept request must carry the ranges to the AS"
  );
});

test("a range on a stream the owner unchecked is not submitted", () => {
  // A leftover date on a deselected stream is noise, not a narrowing.
  assert.match(
    CLIENT_SOURCE,
    /const chosenStreamIds = new Set\(sources\.flatMap\(\(source\) => source\.streamIds\)\)/,
    "ranges must be filtered to streams that survived selection"
  );
  assert.match(CLIENT_SOURCE, /if \(!chosenStreamIds\.has\(streamId\)\)/);
});

test("an empty range is omitted rather than sent as a bound", () => {
  // Sending `{}` would ask the server to record "no bound" as if the owner had
  // chosen one.
  assert.match(CLIENT_SOURCE, /if \(entry\.since \|\| entry\.until\)/);
});

test("the data range and the grant expiry stay separate fields", () => {
  // spec-core.md:889 — grant validity, data temporal scope, and access pattern
  // are three concepts that MUST NOT be conflated. One "date" field would
  // conflate the first two.
  assert.match(ACTIONS_SOURCE, /grant_expiry: decision\.grantExpiry/);
  assert.match(ACTIONS_SOURCE, /stream_range: decision\.streamRanges/);
  assert.match(
    MODEL_SOURCE,
    /readonly streamRanges: Readonly<Record<string, \{ since\?: string; until\?: string \}>>/,
    "the decision model must declare the range separately from grantExpiry"
  );
});

test("the data range is NOT folded into the approval artifact digest", () => {
  // The digest binds the client, the access mode, and which streams were
  // approved — terms the AS re-resolves independently. The range goes through
  // the manifest-checked narrowing path instead, which can reject a range the
  // stream cannot honor; a digest over it would bind a value the AS may
  // legitimately normalize (`until` is exclusive).
  const digestCall = ACTIONS_SOURCE.slice(
    ACTIONS_SOURCE.indexOf("computeHostedMcpDecisionDigest({"),
    ACTIONS_SOURCE.indexOf("return postChallenge")
  );
  assert.ok(digestCall.length > 0, "vacuity guard: the digest call must be found");
  assert.doesNotMatch(digestCall, /streamRanges|stream_range/, "the digest must not cover the data range");
});

test("the owner's selected fields are submitted through the declaration-checked narrowing path", () => {
  assert.match(CLIENT_SOURCE, /initialFieldSelection/, "every manifest field starts selected");
  assert.match(CLIENT_SOURCE, /Choose fields to share/, "Change must reveal a real field list");
  assert.match(CLIENT_SOURCE, /streamFields\[stream\.id\]/, "the decision must keep fields keyed by stable stream id");
  assert.match(ACTIONS_SOURCE, /stream_fields: decision\.streamFields/, "the accept request must carry field selections");
  assert.match(
    AS_HELPERS_SOURCE,
    /readonly fields: ReadonlyArray<\{ readonly description\?: string; readonly name: string; readonly required: boolean \}>/,
    "the AS model must publish the declaration-backed field list"
  );
});

test("field narrowing is NOT folded into the approval artifact digest", () => {
  const digestCall = ACTIONS_SOURCE.slice(
    ACTIONS_SOURCE.indexOf("computeHostedMcpDecisionDigest({"),
    ACTIONS_SOURCE.indexOf("return postChallenge")
  );
  assert.ok(digestCall.length > 0, "vacuity guard: the digest call must be found");
  assert.doesNotMatch(digestCall, /streamFields|stream_fields/, "the digest must not cover manifest-normalized field choices");
});

test("source disclosures use the native details open state, not an invalid DOM defaultOpen prop", () => {
  assert.doesNotMatch(CLIENT_SOURCE, /defaultOpen/, "details has no defaultOpen attribute; React warns and forwards it to the DOM");
  assert.match(CLIENT_SOURCE, /onToggle=\{\(event\)/, "the owner must still be able to open and close each source");
});
