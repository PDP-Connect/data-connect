// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural scanner backing the zero-connector-knowledge conformance guard.
 *
 * Spec: openspec/changes/enforce-ri-zero-connector-knowledge/specs/
 *       reference-implementation-architecture/spec.md
 *
 * Proves RI production code carries no hardcoded connector/provider identity,
 * endpoint, scope, or credential-env-var knowledge. Rules (1)-(4) below are a
 * deliberate text-structural scan over string literals, not a type-checker:
 * that trade (a small amount of theoretical evadability — string
 * concatenation, indirect constants — for zero new toolchain dependency) is
 * still correct for those four rules; see the change's design.md Non-Goals.
 *
 * Rule (5) — whether a sibling JSON/YAML data file can carry the same
 * knowledge these four rules forbid in `.ts` source — is NOT a text-scan
 * non-goal: a syntax-specific regex over one JS shape for reaching a data
 * file cannot back up a "closed" claim (readFileSync/require/dynamic
 * import/static json-attribute-import/new URL all reach the identical file
 * with identical runtime behavior). Rule (5) is delegated to
 * `ri-zero-connector-knowledge-data-load-scan.ts`, a real AST-based scanner
 * that closes the load-site class rather than one syntax shape within it.
 *
 * The scanner derives its notion of "known connector identity" from the
 * shipped manifests themselves (both manifest roots), rather than hardcoding
 * a second connector-name list here — a hand-typed allowlist in the guard
 * would be exactly the violation the guard exists to forbid.
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

import { isExemptDataLoadPath, scanFileDataLoads } from "./ri-zero-connector-knowledge-data-load-scan.ts";
import { scanFileIdentity } from "./ri-zero-connector-knowledge-identity-scan.ts";

export interface ScanRoots {
  /** Absolute path to the repository root. */
  repoRoot: string;
}

export interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const PRODUCTION_SCAN_ROOTS = ["cli", "lib", "operations", "runtime", "scripts", "server"];

// Reference-fixture manifests are still a real repo-relative directory. The
// first-party polyfill manifests are NOT — they ship inside the
// `@pdpp/polyfill-connectors` package, read via its own `readPolyfillManifests()`
// export (see the two functions below), never by walking a repo path.
const REFERENCE_FIXTURE_MANIFEST_ROOT = "reference-implementation/fixtures/seed-manifests";

/**
 * `packages/polyfill-connectors/src/` is the connector-agnostic SHARED
 * library — unlike RI, it is NOT zero-connector-knowledge territory; modules
 * like `orchestrator.ts`, `auto-login/*.ts`, and `static-secret-injection.ts`
 * legitimately hardcode every connector's identity, login URLs, and
 * credential env-var names as their entire purpose. Running rules (1)/(3)/
 * (4)/(5) against this root would be ~100 false positives on exactly the
 * code this package exists to contain, not a real guard.
 *
 * The narrow invariant that DOES hold at this root (per
 * manual-upload-terminal-redteam-0810 finding #3): no file in `src/` outside
 * a short, explicitly reviewed allowlist of already-legitimate
 * connector-importing registries may branch on a manifest-declared
 * `validation.kind` literal or import a connector's own module — this stops
 * a NEW, generically-named file quietly adding a second kind-dispatch or
 * connector-import surface that RI could call blind. It does NOT mean "only
 * one file in this whole root may know about connectors": auditing the real
 * tree surfaced two other pre-existing, legitimate registries with the same
 * shape, both allowlisted below rather than treated as violations:
 * `collector-registry.ts` (the collector-definition-pattern counterpart to
 * `manual-upload-validation.ts`'s validation-pattern registry) and
 * `auto-login/heb.ts` (imports ONLY its own connector's sibling
 * `connectors/heb/parsers.ts` — self-referential, not cross-connector
 * dispatch knowledge). Scanned with ONLY rules (6) and (7) — a hardcoded
 * `validation.kind` literal branch, or a direct import of a connector's own
 * module — never rules (1)/(3)/(4)/(5), which are legitimately violated by
 * the rest of this root by design.
 *
 * This root is the `@pdpp/polyfill-connectors` PACKAGE's `src/`, resolved
 * through the package the same way this file already reads its manifests
 * (see the note above `REFERENCE_FIXTURE_MANIFEST_ROOT`) — not the
 * repo-relative `packages/polyfill-connectors/src/` path this constant used
 * to name. That repo path is a different thing that happens to share a name:
 * `packages/polyfill-connectors` is `@pdpp/polyfill-connectors-vendored-source`,
 * a 19-file closed subset vendored by physical file into
 * `@pdpp/local-collector`'s build (see its own package.json), and it holds
 * none of the files this invariant is written about. Pointing here at that
 * subset scanned 19 unrelated files and returned no violations while every
 * module the guard exists to watch — `orchestrator.ts`, `auto-login/*.ts`,
 * `static-secret-injection.ts` — went unexamined. See
 * {@link sharedLibraryKindDispatchScanFiles} for the guard that keeps that
 * silence from being possible again.
 */
const SHARED_LIBRARY_KIND_DISPATCH_PACKAGE = "@pdpp/polyfill-connectors";

/** Files at the {@link SHARED_LIBRARY_KIND_DISPATCH_PACKAGE} `src/` root legitimately
 * exempt from rules (6)/(7) — see that constant's doc comment for what each
 * entry is and why. Exact-file, not a directory/prefix allowlist: adding a
 * new entry requires deliberately widening this Set, not an incidental path
 * match.
 *
 * `provider-auth-adapters.ts` was ADDED by the AST-authority pass
 * (ri-zero-knowledge-ast-authority-0810): its dynamic `await import(
 * "../connectors/google_maps_data_portability/provider-auth.ts")` registry
 * entry was invisible to the prior regex scanner (which only matched a
 * `polyfill-connectors/connectors/` path segment on an `import`/`export`
 * line, never a dynamic `import()` call reached via a relative,
 * package-root-relative specifier) — genuinely undetected, not
 * newly-introduced. Inspected and confirmed to be the same deterministic,
 * eagerly-loaded, opaque-`exchanger_kind`-mapping registry SHAPE as
 * `manual-upload-validation.ts`/`collector-registry.ts` (see this file's own
 * header doc comment), not a second hidden dispatch seam: it is the ONLY
 * file in this root using dynamic `import()` to reach a connector module
 * (verified by grep across the whole root), and its module list is a
 * closed, eagerly-enumerated array literal, not a runtime-constructed path. */
const SHARED_LIBRARY_KIND_DISPATCH_ALLOWLIST = new Set([
  "packages/polyfill-connectors/src/manual-upload-validation.ts",
  "packages/polyfill-connectors/src/collector-registry.ts",
  "packages/polyfill-connectors/src/auto-login/heb.ts",
  "packages/polyfill-connectors/src/provider-auth-adapters.ts",
]);

/**
 * The shared library is read from the installed package, but its files are
 * still REPORTED under the `packages/polyfill-connectors/src/...` names above
 * — that is the path a reader opens to inspect a violation, and it keeps the
 * allowlist and every `Violation.file` in this root stable across whatever
 * physical location the package resolves to (hoisted `node_modules`, a
 * workspace link, an unpacked tarball).
 */
const SHARED_LIBRARY_REPORTED_PATH_PREFIX = "packages/polyfill-connectors/src";

const REGISTRY_ID_PREFIX = "https://registry.pdpp.dev/connectors/";

/** Hosts that are generic/protocol/infra, never provider-specific. Anything else
 * appearing as a literal absolute URL host in production code is a violation. */
const GENERIC_URL_HOSTS = new Set([
  "registry.pdpp.dev",
  "pdpp.dev",
  "registry.pdpp.org",
  "pdpp.org",
  "pdpp.local",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "example.com",
  "example.test",
  "foreign.example",
  "dashboard.example",
  "schema.org",
  "www.w3.org",
  "w3.org",
  "www.iana.org",
  "iana.org",
  "json-schema.org",
  "www.standardwebhooks.com",
  "standardwebhooks.com",
  "www.rfc-editor.org",
  // n.eko is the RI's own self-hosted browser-surface runtime (see
  // reference-native-provider-boundary spec), not a third-party data
  // provider — its in-network Docker service names are RI infra, same
  // status as `localhost`.
  "neko",
  "neko.local",
  "neko-playground",
  "allocator.local",
  "cdp.local",
]);

/** Env-var name shapes that are always generic (never provider-specific). */
const GENERIC_ENV_PREFIXES = ["PDPP_", "NODE_", "CI_", "GITHUB_ACTIONS", "npm_", "NEKO_"];

// The repository's full executable JS/TS extension set (matches this repo's
// own module-resolution surface: `tsconfig.json`'s `allowJs`, and real
// production/tooling files under these roots today — e.g.
// `scripts/run-tests-failure.js`, `scripts/*.test.mjs`). A production file
// under any of these extensions can carry the same hardcoded-identity/
// endpoint/env-key/data-load violations as a `.ts` file; scanning only `.ts`
// left every one of these siblings invisible to the guard. `.d.ts`
// declaration files are excluded (type-only, no executable content to scan).
const EXECUTABLE_JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const TEST_FILE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".test.mts",
  ".test.cts",
  ".test.mjs",
  ".test.cjs",
];

function walkTsFiles(dir: string, scanRootDir: string, repoRoot: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walkTsFiles(abs, scanRootDir, repoRoot, out);
      continue;
    }
    if (!EXECUTABLE_JS_TS_EXTENSIONS.has(extname(entry))) {
      continue;
    }
    if (entry.endsWith(".d.ts") || TEST_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      continue;
    }
    // Exemption is checked relative to THIS FILE'S OWN scan root (e.g.
    // `server/`), matching only the intended top-level directories
    // (`server/connectors/`, `server/generated/`, ...) — not any directory
    // sharing that name at arbitrary depth (a `server/foo/connectors/`
    // shape does not exist in this codebase and must not be exempt).
    if (isExemptDataLoadPath(relative(scanRootDir, abs))) {
      continue;
    }
    out.push(relative(repoRoot, abs));
  }
}

/** Every RI production `.ts` file in scope for the guard. */
export function productionFiles({ repoRoot }: ScanRoots): string[] {
  const riRoot = join(repoRoot, "reference-implementation");
  const out: string[] = [];
  for (const root of PRODUCTION_SCAN_ROOTS) {
    const scanRootDir = join(riRoot, root);
    walkTsFiles(scanRootDir, scanRootDir, repoRoot, out);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Absolute path to the installed {@link SHARED_LIBRARY_KIND_DISPATCH_PACKAGE}'s
 * `src/`. Resolved through the package's own `./collectors` export (which
 * points at `src/collector-registry.ts`) rather than a hardcoded
 * `node_modules/...` path, so this follows the package wherever it is
 * installed from — the same posture as this file's `readPolyfillManifests()`
 * import.
 */
export function sharedLibrarySrcDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${SHARED_LIBRARY_KIND_DISPATCH_PACKAGE}/collectors`));
}

/** The stable reported name for a file at {@link sharedLibrarySrcDir}, e.g.
 * `packages/polyfill-connectors/src/orchestrator.ts`. Exported so
 * falsifiability tests can inject a synthetic file into the root the scanner
 * really walks and predict the path it will be reported under. */
export function sharedLibraryReportedPath(packageRelPath: string): string {
  return `${SHARED_LIBRARY_REPORTED_PATH_PREFIX}/${packageRelPath.split("\\").join("/")}`;
}

/** Every file at the shared library's `src/`, minus the exact-file allowlist
 * entries — the file set rules (6)/(7) run against.
 *
 * Takes {@link ScanRoots} for call-site symmetry with the other scan-set
 * functions, but reads none of it: this root is resolved through the package,
 * not off `repoRoot`. */
export function sharedLibraryKindDispatchScanFiles(_roots: ScanRoots): string[] {
  const scanRootDir = sharedLibrarySrcDir();
  const absolute: string[] = [];
  // `walkTsFiles` reports paths relative to its `repoRoot` argument; the
  // package lives outside the repo tree, so walk relative to the scan root and
  // re-prefix below rather than emitting a pile of `../../` paths.
  walkTsFiles(scanRootDir, scanRootDir, scanRootDir, absolute);

  // A root that resolves to nothing is the failure mode that let this guard
  // drift: `walkTsFiles` swallows a missing directory and returns [], which
  // reads downstream as "scanned everything, found nothing wrong". An empty
  // shared library is not a real state of this repo, so say so loudly instead
  // of reporting a vacuous pass.
  if (absolute.length === 0) {
    throw new Error(
      `${SHARED_LIBRARY_KIND_DISPATCH_PACKAGE} resolved to ${scanRootDir}, which contains no scannable files. ` +
        "The shared-library kind-dispatch guard would silently pass against an empty file set. " +
        "Install dependencies, or fix the package resolution, before trusting this scan."
    );
  }

  return absolute
    .map((packageRelPath) => sharedLibraryReportedPath(packageRelPath))
    .filter((relPath) => !SHARED_LIBRARY_KIND_DISPATCH_ALLOWLIST.has(relPath))
    .sort((a, b) => a.localeCompare(b));
}

function connectorKeyFromManifestId(id: unknown): string | null {
  if (typeof id !== "string" || !id.startsWith(REGISTRY_ID_PREFIX)) {
    return null;
  }
  return id.slice(REGISTRY_ID_PREFIX.length);
}

/** Every reference-fixture manifest under `reference-implementation/fixtures/seed-manifests`,
 * parsed. Malformed/unreadable entries are skipped, matching this scanner's
 * long-standing posture: a broken manifest contributes no policy, it does not
 * crash the guard. */
function readReferenceFixtureManifests(repoRoot: string): Record<string, unknown>[] {
  const dir = join(repoRoot, REFERENCE_FIXTURE_MANIFEST_ROOT);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const parsedManifests: Record<string, unknown>[] = [];
  for (const file of files) {
    try {
      parsedManifests.push(JSON.parse(readFileSync(join(dir, file), "utf8")));
    } catch {
      // Skip: a broken reference-fixture manifest contributes no policy.
    }
  }
  return parsedManifests;
}

/** Every manifest `@pdpp/polyfill-connectors` ships, parsed. An unreadable
 * manifest set contributes zero entries (matching this scanner's posture for
 * the reference-fixture root above) rather than crashing the guard. */
function readShippedPolyfillManifests(): Record<string, unknown>[] {
  try {
    return readPolyfillManifests().map((entry) => entry.manifest as Record<string, unknown>);
  } catch {
    return [];
  }
}

function allShippedManifests(repoRoot: string): Record<string, unknown>[] {
  return [...readShippedPolyfillManifests(), ...readReferenceFixtureManifests(repoRoot)];
}

/** Reads `connector_key`/`connector_id` from every manifest across both
 * sources. This is the guard's sole source of "known connector identity" —
 * never hand-typed. */
export function manifestDerivedConnectorKeys({ repoRoot }: ScanRoots): Set<string> {
  const keys = new Set<string>();
  for (const parsed of allShippedManifests(repoRoot)) {
    const key = parsed.connector_key;
    if (typeof key === "string" && key.length > 0) {
      keys.add(key);
    }
    const derivedFromId = connectorKeyFromManifestId(parsed.connector_id);
    if (derivedFromId) {
      keys.add(derivedFromId);
    }
  }
  return keys;
}

/** Reads `setup.manual_or_upload.validation.kind` from every manifest across
 * both sources — a SEPARATE identity namespace from `connector_key`/`connector_id`
 * (e.g. `"whatsapp_chat_export"` vs `"whatsapp"`), added after a real
 * violation shipped that a `kind ===` string match against a manifest's own
 * `validation.kind` value is just as much hardcoded connector knowledge as a
 * `connector_key` match, and the original scanner had no notion of this
 * second namespace at all. */
export function manifestDerivedValidationKinds({ repoRoot }: ScanRoots): Set<string> {
  const kinds = new Set<string>();
  for (const parsed of allShippedManifests(repoRoot)) {
    const setup = parsed.setup as { manual_or_upload?: { validation?: { kind?: unknown } } } | undefined;
    const kind = setup?.manual_or_upload?.validation?.kind;
    if (typeof kind === "string" && kind.length > 0) {
      kinds.add(kind);
    }
  }
  return kinds;
}

const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function stripComments(source: string): string {
  // Blank out line and block comments so literals inside comments/docs don't
  // false-positive, while preserving line numbers (newlines kept intact).
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, pre) => pre + " ".repeat(m.length - pre.length));
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function lineTextAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|API_KEY|ACCESS_TOKEN|PASSWORD)$/;
const ABSOLUTE_URL_HOST_RE = /^https?:\/\/([^/\s:]+)/;

/**
 * Scans one production file's source for the seven violation shapes:
 * (1)/(6)/(7)/(4b) — connector-identity literals, validation-kind literals,
 *     connector-module imports, and connector-manifest-import-then-extract —
 *     are AST-based (see `ri-zero-connector-knowledge-identity-scan.ts`'s
 *     module doc comment): a bounded constant-folder resolves string values
 *     and import specifiers through `const`/one-hop-parameter indirection so
 *     ordinary indirection (a kind literal assigned then compared,
 *     `.includes()`/`switch`/re-export/dynamic-import, importing a connector
 *     manifest and reading `.kind` off it) is caught the same as an inline
 *     literal, not just a bare `===` sitting next to an identity-shaped name.
 * (3) a literal absolute URL whose host isn't on the generic allowlist —
 *     still a text-structural regex scan (see this module's own doc
 *     comment: standalone URL literals have no meaningful indirection shape
 *     worth an AST pass for).
 * (4) a provider-shaped credential env-var name literal — same posture as (3).
 * (5) a JSON/YAML data-resource load (readFileSync/readFile/require/dynamic
 *     import/static json-attribute import/new URL, resolved via a bounded
 *     AST-based constant-folder — see
 *     `ri-zero-connector-knowledge-data-load-scan.ts`) that is neither a
 *     sanctioned-and-provenance-checked manifest-root read, an explicitly
 *     allowlisted RI-owned policy resource, nor an explicitly reviewed
 *     generic-data-read call site.
 */
export function scanFile(
  absPath: string,
  relPath: string,
  connectorKeys: Set<string>,
  repoRoot: string,
  validationKinds: Set<string> = new Set()
): Violation[] {
  const raw = readFileSync(absPath, "utf8");
  const source = stripComments(raw);
  const violations: Violation[] = [];

  const literalMatches = [...source.matchAll(STRING_LITERAL_RE)].map((m) => ({
    index: m.index ?? 0,
    value: m[2] ?? "",
  }));

  for (const { index, value } of literalMatches) {
    const urlMatch = value.match(ABSOLUTE_URL_HOST_RE);
    if (urlMatch) {
      const host = (urlMatch[1] ?? "").toLowerCase();
      // `${...}` (template-literal interpolation, since the literal scanner
      // doesn't distinguish backtick templates from quoted strings) and
      // `{placeholder}` host segments are not hardcoded hosts at all — a
      // dynamically-assembled or placeholder-templated URL carries no
      // provider knowledge by itself.
      const isPlaceholderHost = host.includes("$") || host.includes("{");
      if (host && !isPlaceholderHost && !GENERIC_URL_HOSTS.has(host)) {
        violations.push({
          file: relPath,
          line: lineNumberAt(source, index),
          rule: "hardcoded-provider-endpoint-url",
          snippet: lineTextAt(raw, index),
        });
      }
      continue;
    }

    if (ENV_KEY_RE.test(value) && !GENERIC_ENV_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      violations.push({
        file: relPath,
        line: lineNumberAt(source, index),
        rule: "hardcoded-provider-credential-env-key",
        snippet: lineTextAt(raw, index),
      });
    }
  }

  const isSharedLibraryFile = relPath.startsWith(`${SHARED_LIBRARY_REPORTED_PATH_PREFIX}/`);
  violations.push(
    ...scanFileIdentity(absPath, relPath, connectorKeys, validationKinds, isSharedLibraryFile).map((v) => ({
      file: v.file,
      line: v.line,
      rule: v.rule,
      snippet: v.snippet,
    }))
  );
  violations.push(...scanFileDataLoads(absPath, relPath, repoRoot, connectorKeys, validationKinds));

  // Multiple literals on one line (e.g. a multi-entry array literal) each
  // independently match the same rule; collapse to one report per
  // file:line:rule so the inventory reads as one fix action per site.
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.line}:${v.rule}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const SHARED_LIBRARY_KIND_DISPATCH_RULES = new Set([
  "hardcoded-validation-kind-literal",
  "connector-module-import",
  "hardcoded-connector-manifest-import",
  // A file the identity scanner cannot parse at all cannot be proven free of
  // rules (6)/(7)/(4b) either — must stay in this narrower allowlist too, or
  // an unparseable shared-library file would silently pass this scan.
  "unparseable-production-file",
]);

/**
 * Scans one {@link SHARED_LIBRARY_KIND_DISPATCH_PACKAGE} `src/` file for ONLY
 * rules (6)/(7)/(4b) — see that constant's doc comment for why rules (1)/(3)/
 * (4)/(5) do not apply here. Exported (not inlined into
 * {@link scanSharedLibraryKindDispatchRoot}) so falsifiability tests can
 * exercise it directly against a synthetic file, mirroring how `scanFile`
 * itself is unit-tested.
 */
export function scanSharedLibraryKindDispatchFile(
  absPath: string,
  relPath: string,
  validationKinds: Set<string>,
  repoRoot: string
): Violation[] {
  return scanFile(absPath, relPath, new Set(), repoRoot, validationKinds).filter((v) =>
    SHARED_LIBRARY_KIND_DISPATCH_RULES.has(v.rule)
  );
}

export function scanSharedLibraryKindDispatchRoot(roots: ScanRoots): Violation[] {
  const validationKinds = manifestDerivedValidationKinds(roots);
  const files = sharedLibraryKindDispatchScanFiles(roots);
  const scanRootDir = sharedLibrarySrcDir();
  const violations: Violation[] = [];
  for (const relPath of files) {
    // Read from where the package actually is; report under the stable
    // `packages/polyfill-connectors/src/...` name (see
    // {@link SHARED_LIBRARY_REPORTED_PATH_PREFIX}).
    const absPath = join(scanRootDir, relPath.slice(`${SHARED_LIBRARY_REPORTED_PATH_PREFIX}/`.length));
    violations.push(...scanSharedLibraryKindDispatchFile(absPath, relPath, validationKinds, roots.repoRoot));
  }
  return violations;
}

export function scanRepository(roots: ScanRoots): Violation[] {
  const connectorKeys = manifestDerivedConnectorKeys(roots);
  const validationKinds = manifestDerivedValidationKinds(roots);
  const files = productionFiles(roots);
  const violations: Violation[] = [];
  for (const relPath of files) {
    violations.push(
      ...scanFile(join(roots.repoRoot, relPath), relPath, connectorKeys, roots.repoRoot, validationKinds)
    );
  }
  violations.push(...scanSharedLibraryKindDispatchRoot(roots));
  return violations;
}

export function formatViolationInventory(violations: Violation[]): string {
  if (violations.length === 0) {
    return "no violations";
  }
  const lines = violations
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
  return `${violations.length} violation(s):\n${lines.join("\n")}`;
}
