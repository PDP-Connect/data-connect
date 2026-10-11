# Vendored cross-repo dependency tarballs (transitional)

## `@pdpp/reference-contract` — compiled snapshot of the canonical contract

`PDP-Connect/pdpp` owns the route manifests, schemas, validators, OpenAPI, and
documentation generators in `packages/reference-contract`. This repository
consumes a compiled snapshot through
`file:./vendor/pdpp-reference-contract-0.1.0.tgz`.

The packed `package.json` records the exact repository, commit SHA, and package
path in `vendorSource`. Read that field for the current source provenance;
`SHA256SUMS` and the root lockfile bind the compiled artifact's bytes.

Rebuild from a local pdpp checkout and a full, committed source SHA:

```sh
node scripts/revendor-reference-contract.mjs /path/to/pdpp <full-commit-sha>
```

The builder archives only the pinned commit's package, so uncommitted source
changes do not enter the artifact. It compiles `src/` with the existing compiler
and dependencies in a unique directory under `~/.tmp`, rewrites package
entrypoints to `dist/*.js` with `dist/*.d.ts` types, records source provenance,
and runs `npm pack --ignore-scripts`. It updates this tarball, its checksum,
and only its root lockfile integrity. It removes only its own scratch directory;
it does not install dependencies or change the source checkout.

The data-connect root must have existing dependencies and a TypeScript compiler
(`node_modules/typescript/bin/tsc`, or `node_modules/.bin/tsc`). When the source
package has its own `node_modules`, the scratch package uses those dependencies
for compilation; otherwise it uses the data-connect root dependencies. The
contract requires AJV 8, so a root installation with AJV 6 needs the source
package's dependencies available. Compiler and dependency versions must match
when comparing rebuilt artifacts byte for byte.

The compiled `./docs` export exposes the canonical documentation generator.
After making the rebuilt package available to the consumer, regenerate and
check the derived OpenAPI and route documentation from the repository root:

```sh
npm run reference-contract:generate
npm run reference-contract:check-generated
```

These commands use `scripts/reference-contract-artifacts.mjs`; `--check`
compares every generated artifact with the canonical package's output. Node
loads compiled JavaScript from the vendored package because it does not strip
TypeScript inside `node_modules`.

A future registry release can replace the `file:` dependency once the owner
publishes the compiled package. Remove this tarball and its checksum entry and
refresh the lockfile as part of that migration.

## `@pdpp/polyfill-connectors` — pinned tarball, canonical `data-connectors` package (Move B seam closure)

The tarball remains in this repository for host-side conformance tests,
connector-registry generation, and the reference-stack setup helper. It is a
development dependency only. Production Docker builds do not copy or install
it: the reference implementation reaches its helper surface through an
optional compatibility boundary, and executable connector implementations
come from the verified connector-install catalog. Keep this tarball until all
of those host-side consumers are migrated; removing it from the image is the
deployment boundary covered by this document.

Same interim mechanism as `@pdpp/reference-contract` above: a committed tarball built
with a plain `npm pack`, referenced via a `file:` dependency, digest recorded in
`SHA256SUMS`. This one pins `packages/polyfill-connectors` from `PDP-Connect/data-connectors`
— the canonical connector package Move A made real — at commit
`d2832953d999241f40129f0a8a14f0bd800c2923` (`main`, 2026-09-02), which merged
`data-connectors#56` adding the 33 export subpaths this moved server needs
(`connector-runtime`, `browser-handoff`, `credential-probe`, the `apple_health` /
`google_maps` / `google_maps_data_portability` / `netflix_export` / `whatsapp` connector
packages, etc. — see that PR for the full list), superseding the earlier pin at
`870b4cd495569f901671a7835be0696a787cf192` to also carry `data-connectors#57`'s fix for
the package's own `postinstall` hook (previously raw TypeScript, which crashed a plain
`npm ci` in any repo that vendors this tarball — see that PR).

This tarball is NOT a byte-identical `npm pack` of the package directory (unlike
`reference-contract` above): `@pdpp/polyfill-connectors`'s own `package.json` declares
its `@pdpp/collector-runtime` / `@pdpp/connector-protocol` / `@pdpp/reference-contract`
dependencies as `file:./vendor/*.tgz` pointing at ITS OWN nested vendor tarballs — paths
that resolve relative to wherever the package lands, which breaks once this tarball is
unpacked inside data-connect's own `node_modules` (nested `file:` deps do not compose).
Those three deps already exist natively in data-connect (`packages/collector-runtime`
and `packages/connector-protocol` as workspace members, `@pdpp/reference-contract` as
its own separate vendored tarball above), so before packing, this tarball's
`package.json` had those three deps rewritten from `file:./vendor/*.tgz` to `*` (matching
how `reference-implementation/package.json` itself already depends on
`@pdpp/collector-runtime`/`@pdpp/connector-protocol`), and its now-unused nested
`vendor/` directory was deleted. No other file was modified. Re-derivable: `npm pack` the
package from `data-connectors` at the SHA below, edit those three dependency lines the
same way, delete `vendor/`, `npm pack` again.

Host-side conformance tests and the reference-stack helper depend on it via
`"file:./vendor/pdpp-polyfill-connectors-0.0.1.tgz"`. The production server
uses `reference-implementation/server/polyfill-connectors-runtime.ts` as an
optional boundary: it loads the package's subpaths when the development
dependency is present, and returns safe empty or fail-closed behavior when the
catalog has not installed a connector. Manifest JSON access uses the package's
`readPolyfillManifests()` export in that development path rather than a direct
file-path read. Executable production implementations come from the verified
connector-install roots, not this tarball.

**Swapping the host-side dependency to a real registry release is a one-line change**
once the owner publishes `@pdpp/polyfill-connectors`: replace the `file:` path with the
published semver range, delete this tarball and its `SHA256SUMS` line, and run
`npm install`. The optional boundary keeps the package's public surface unchanged.

**Update (2026-09-03): pin moved to `data-connectors` commit `262c7bd80c9b4919a274702f6a75b0fb4e7fb1d0`
(`main`, merge of `data-connectors#68`, "fix(polyfill-connectors): publish JavaScript
entrypoints" — fixes `data-connectors#67`).** Supersedes the 2026-09-02 pin above and its
whole hand-rolled dual-compile workaround (depth-mismatched `manifests` export, flat/nested
`dist/` duplicates, the deliberately-excluded-and-broken `generate-static-secret-registry.ts`
— all of that is gone; see this repo's git history for the old note if the mechanism ever
needs archaeology). `data-connectors#68` fixed the defect class at its actual source: the
package's own `package.json` now has a real `prepack` hook
(`hydrate-vendored-runtime && build`) that runs a proper `tsc --project tsconfig.build.json`
covering `src/**`, all `connectors/*` needed transitively, `bin/local-device-exporter.ts`,
`bin/scrub-fixtures.ts`, `bin/test-fixture-capture.ts`, AND
`scripts/generate-static-secret-registry.ts` (the file `#67` found still broken) — compiled
IN PLACE (`.js` next to `.ts`, no separate `dist/` directory, so no depth-mismatch class of
bug is possible). `exports` already point at the compiled `.js` files directly from
`data-connectors`' own package.json; this repo's vendoring step no longer needs to touch
`exports` at all.

Re-derivable: `npm install && npm pack` the package from `data-connectors` at the pinned
commit (prepack builds automatically) — this alone was verified sufficient: extracted the
result, confirmed `src/manifest-registry.js` (compiled) sits next to `src/manifest-registry.ts`
(source, kept for reference/debugging), confirmed `@pdpp/polyfill-connectors/manifests`
imports cleanly, confirmed `scripts/generate-static-secret-registry.js` and
`bin/local-device-exporter.js` (the two entry points `#67` found crashing) both run to
completion with no `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, from a real
`npm install`ed consumer. The only edit still needed post-pack is the same one this
package has always needed regardless of the TS-stripping fix: rewrite its two nested
`file:./vendor/*.tgz` dependencies (`@pdpp/collector-runtime`, `@pdpp/connector-protocol`
— both already exist natively in this repo, see above) to `*`, then delete the now-unused
`vendor/` directory the package shipped with. Note the ORDER matters: `npm pack`'s own
`prepack` (`hydrate-vendored-runtime`) needs `vendor/*.tgz` present to run, so do the
`file:`→`*` edit and `vendor/` deletion AFTER packing (on the extracted tarball contents,
then re-tar with `tar -czf out.tgz package/`), never before.

**Update (2026-09-03, later same day): pin moved again to `data-connectors` commit
`dc4008c348d7066a09c067f05189fd2f8c23c80f`** (`main`, merge of `data-connectors#70`,
"bless github, github/schemas, and fixture-samples exports"). The `262c7bd8` pin above
fixed TS-stripping but its own same-day companion commit also added a `package.json`
`"files"` allowlist narrowing the tarball to compiled `.js` under a short explicit list —
correct npm hygiene (a published package shouldn't ship raw source/tests to consumers),
but it dropped 1115 files this repo reaches into directly, causing 14 new local test
failures on a first attempt to re-vendor from `262c7bd8` as-is. Full enumeration of every
path this repo reaches past the blessed `exports`, and the classification of each, is
posted on `data-connect#55`'s own PR thread. `data-connectors#70` additively blessed the
two genuine narrow needs (`./connectors/github`, `./connectors/github/schemas`, and a new
`./fixture-samples` helper export backed by the package's own shipped fixtures — no raw
file paths exposed) rather than widening `files` back to raw source. Two remaining reaches
(a whole-connector-tree forbidden-import scan and this repo's own production
connector-path-discovery mechanism, both needing all 45 manifest-listed connectors'
source, not a named few) are NOT resolved by this pin — tracked as an open, bigger
decision, not something this vendoring step can paper over. Re-derivation recipe is
otherwise identical to the `262c7bd8` note above (`npm install && npm pack`, rewrite the
2 nested `file:` deps to `*` AFTER packing, delete `vendor/`, re-tar) — the `files`
allowlist and additive exports live entirely in `data-connectors`, nothing about this
repo's own re-vendor mechanics changed.

**Update (2026-09-03, later same day): pin moved a third time to `data-connectors` commit
`878b4cae785d1d444ff17fff5c44726528209745`** (`main`, merge of `data-connectors#74`, "fix
declarations for polyfill-connectors" — fixes `data-connectors#71`). The `dc4008c3` pin
above fixed the two named export needs but exposed a THIRD, separate defect: this
package's `tsconfig.build.json` set `declaration: false`, so its real build never emitted
any `.d.ts` for any of its 42 export subpaths — every TypeScript consumer (this repo
included) got implicit `any` for everything imported from it, tripping strict-mode
diagnostics. This was masked in every earlier local check here because this repo's own
INTERIM hand-rolled vendoring step (before `#68` existed) had set `declaration: true` in
its own scratch build config, shipping 120 `.d.ts` files that happened to paper over the
gap — first genuinely caught running `npm --prefix reference-implementation run typecheck`
(the exact command CI's "typecheck reference implementation" job runs, NOT the root
`npm run typecheck`, whose project references never actually cover this directory) against
a real `dc4008c3` re-vendor. `data-connectors#74` fixed it at source: `.d.ts` + `.d.ts.map`
now ship for all 42 subpaths, with NodeNext- and bundler-moduleResolution proofs and a
pack-time guard against regressing. Confirmed via
`npm --prefix reference-implementation run typecheck`: clean at this pin. Re-derivation
recipe is otherwise identical to the two notes above.

**Update (2026-09-03, later still same day): pin moved a fourth time to `data-connectors`
commit `c80e05bea98ba2eeda3bcf45598d9fb239a25902`** (`main`, merge of `data-connectors#75`,
"feat: ship all connector implementations"). This is the fix for the connector-tree-scope
gap that `runtime/controller.ts` and `test/connector-config-no-self-declaration.test.ts`
both had (see their own `SWAP POINT` comments, added as prep in an earlier commit on this
branch): the package now compiles and ships built JS + `.d.ts` for all 45 manifest-listed
connectors (previously only 12 were compiled), plus a new `./resolve` export —
`resolveConnectorImplementation(connectorId): { entry, manifest, brandIcon }` (file-URL
strings, safe for `await import(entry)` directly), backed by a generated
`connector-index.json` that also now ships in `files`. Unknown IDs throw a typed
`ConnectorImplementationNotFoundError` (`.code === "ERR_PDPP_CONNECTOR_IMPLEMENTATION_NOT_FOUND"`),
not a silent null/undefined. Verified directly against this pin from a real installed
consumer: `resolveConnectorImplementation("https://registry.pdpp.dev/connectors/ynab")`
returns a real `file://` entry whose module imports and exposes real exports; an unknown
ID throws the typed error. This repo's own `resolvePolyfillConnectorEntryPoint()` (in
`runtime/controller.ts`) and `listConnectorSourceFiles()` (in
`test/connector-config-no-self-declaration.test.ts`) were swapped to call this export
instead of walking `POLYFILL_CONNECTORS_DIR` — see those functions' own updated comments
for what changed. Re-derivation recipe is otherwise identical to the three notes above.

**Update (2026-09-06): pin moved to `data-connectors` commit
`8372d0308678985adf86c1a664bc251f50dc7246`** (`main`, including
`data-connectors#78` and `#77`). `#78` removes Signal's unsupported
`proven.local_collector` declaration; `#77` demotes unproven connectors and adds the
related-test selector. The tarball is rebuilt with the upstream `prepack` command, then
its nested `vendor/` directory and bundled copies of collector-runtime and
connector-protocol are removed. Its three in-repo dependencies
(`@pdpp/collector-runtime`, `@pdpp/connector-protocol`, and
`@pdpp/reference-contract`) are declared as `*`, so the host's pinned copies remain the
single runtime source. The tarball checksum and root lock integrity bind this exact
post-pack artifact.

**Update (2026-09-10): pin moved to `data-connectors` commit
`4c4c87fc337158ecfa640af3ebdbcceeafc7a0f3`** (`main`, the merge commit of
data-connectors#92). Rebuilt with `scripts/revendor-polyfill-connectors.sh` for the
malformed-line isolation fix and the Codex symlink-gap fix in data-connectors#92. The
upstream connector index is regenerated before packing; host-provided dependencies and
bundled local collector sources are updated using the same post-pack procedure above.
This replaces the three interim PR-head pins recorded while #92 was open
(`f57aa6f5a`, `f5adf2546`, `b17342743`), which are superseded and no longer current.

**Update (2026-09-18): pin moved to `data-connectors` commit
`243c3d726b278bc0da14b7047f37d9805c620e2f`** (`main`, data-connectors#139, the
LinkedIn/ChatGPT icon normalization fix). The prior pin (2026-09-10) had gone two days
stale with no automated signal: `scripts/revendor-polyfill-connectors.sh`'s connector-file
patch step (added for #92's malformed-line fix) does not apply to an icon-only change, so
this re-vendor ran the tarball-only portion of that script by hand — pack, repoint the
three in-repo `*` dependencies, strip `vendor/`/`node_modules`, update `SHA256SUMS`, clear
and refresh `package-lock.json` integrity — and skipped the `claude_code`/`codex`
connector-source copy, which is orthogonal to this pin and script-updates its own
hardcoded targets pin-to-pin. See `scripts/check-polyfill-connectors-tarball-freshness.mjs`
for the check that now fails CI instead of letting a future pin go silently stale.

**Update (2026-09-25): pin moved to data-connectors commit `d2d9007a91cd7e5035d6d70e5273985354d8dfff`.**
Rebuilt with `scripts/revendor-polyfill-connectors.sh` to clear the 7-day
freshness limit. This is the last data-connectors commit before the 2026-09-22
connector cutover; later pins change manifests this reference implementation
does not yet accept (for example `heb` stream selections without `resources`).
The bundled `claude_code` source stays at data-connectors@5f17986, as
`packages/polyfill-connectors/vendor-source.json` records.

**Update (2026-09-30):** the packed connector runtime includes the host Chrome CDP
patch from PDP-Connect PR #329. The upstream data-connectors pin predates this seam;
`scripts/check-polyfill-connectors-tarball-freshness.mjs` applies the same patch to its
rebuild before comparing package contents. The installed-package regression test
`test/connector-runtime-vendored-host-cdp.test.ts` guards the runtime shipped in the app.
