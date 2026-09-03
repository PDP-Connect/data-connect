# Vendored cross-repo dependency tarballs (transitional)

## `@pdpp/reference-contract` — pinned tarball, not a registry release (Move B decision Q2, interim)

Move B's own decisions doc asked for either a published, pinned npm release, or a
generated snapshot. A real `npm publish` needs registry credentials this move did not
have available, so this pins the same way `PDP-Connect/pdpp`'s own `vendor/` directory
already pins `@pdpp/collector-runtime` and `@pdpp/connector-protocol` from data-connect
(see that repo's `vendor/README.md` for the precedent this mirrors) — a committed tarball
built with a plain `npm pack`, referenced via a `file:` dependency, with its digest
recorded below.

`pdpp-reference-contract-0.1.0.tgz` was originally built via `npm pack` from
`packages/reference-contract` at `PDP-Connect/pdpp` commit
`0d3deca19186a2185a6a15ab76c71352d10e627e` (`main`, 2026-09-02). SHA-256 is recorded in
`SHA256SUMS` in this directory.

`reference-implementation/package.json` depends on it via
`"file:./vendor/pdpp-reference-contract-0.1.0.tgz"`.

**Update (2026-09-02, data-connect seam-fix): compiled JS, not raw `.ts`, is now
vendored.** The package ships raw TypeScript source with no build step in `pdpp` itself
(`main`/`exports` there point directly at `./src/*.ts`) — that is fine inside `pdpp`'s
own repo, where Node's native type-stripping applies normally to first-party source, but
once vendored as a tarball unpacked into THIS repo's `node_modules`, every one of those
files sits under `node_modules`, and Node deliberately refuses to strip types there
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) as a fixed platform policy. This broke
the `pdpp` CLI (`reference-implementation/cli/index.ts`) the moment any command reached a
`server/*.ts` file that imports `@pdpp/reference-contract` — a real defect for any real
invocation of this repo's CLI, not just a test-harness quirk (confirmed live: `node
cli/index.ts --help` crashed with this exact error before this fix).

Since `pdpp` itself is out of scope to change from here (this fix originates in
`PDP-Connect/data-connect`, and the true fix — publishing `@pdpp/reference-contract` with
a compiled-JS build — is the owner's call to make in `pdpp`), this repo's OWN vendoring
step now compiles the tarball's contents before packing, rather than shipping a
byte-identical `npm pack` of the source directory. Re-derivable:

```
npm pack packages/reference-contract   # from a pdpp checkout at the pinned commit
tar -xzf pdpp-reference-contract-0.1.0.tgz -C /tmp/rc && cd /tmp/rc/package
# add a temporary build tsconfig: noEmit:false, outDir:"./dist", rootDir:"./src",
# rewriteRelativeImportExtensions:true, declaration:true, include: src/**/*.ts + src/**/*.js
npx tsc -p tsconfig.build.json && rm tsconfig.build.json
# edit package.json: exports/main/types point at ./dist/... instead of ./src/...
# (9 exports subpaths + main + types; src/ stays in the tarball too, unedited, for
# anyone reading/debugging — only the exports map changed)
npm pack .
```

`src/` (raw TypeScript, for reference/debugging) and `test/` ship in the tarball
alongside the new `dist/` (compiled JS + `.d.ts`); only `exports`/`main`/`types` in
`package.json` changed to point at `dist/`. Every one of the 9 `exports` subpaths was
verified to import and resolve cleanly from the compiled output before repacking.

**Swapping to a real registry release is still a one-line change** once the owner
publishes `@pdpp/reference-contract` (ideally WITH a real build step, so this repo can
depend on a published semver range instead of carrying its own compile-and-repack step):
replace the `file:` path in `reference-implementation/package.json` with the published
semver range (e.g. `^0.1.0`), delete this tarball and its `SHA256SUMS` line, run `npm
install`. No other code changes are needed — the package's public surface (all 9
`exports` subpaths) is unchanged from the source it was packed from, only compiled.

## `@pdpp/polyfill-connectors` — pinned tarball, canonical `data-connectors` package (Move B seam closure)

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

`reference-implementation/package.json` depends on it via
`"file:./vendor/pdpp-polyfill-connectors-0.0.1.tgz"`. Every import inside
`reference-implementation` that used to reach `../../packages/polyfill-connectors/src/*.ts`
or `../../packages/polyfill-connectors/connectors/*/index.ts` by relative file path now
imports `@pdpp/polyfill-connectors/<subpath>` instead — production code and tests alike.
Manifest JSON access goes through the package's own `readPolyfillManifests()` export
(`@pdpp/polyfill-connectors/manifests`) rather than a direct file-path read, since the
package does not expose individual manifest files by path.

**Swapping to a real registry release is a one-line change** once the owner publishes
`@pdpp/polyfill-connectors`: replace the `file:` path with the published semver range,
delete this tarball and its `SHA256SUMS` line, run `npm install`. No import-site changes
are needed — they already reference the package by name, not by file path.

**Update (2026-09-02, data-connect seam-fix): the package's own `src/` tree (30 `exports`
subpaths) now ships compiled JS.** Same defect class as `@pdpp/reference-contract` above —
this package (like that one) ships raw TypeScript source with no build step, correct
inside `data-connectors`' own repo but broken once vendored into this repo's
`node_modules`, where Node refuses to strip types. Confirmed live before this fix:
`reference-implementation/scripts/generate-connector-registry.ts` and
`reference-implementation/scripts/compact-record-history.ts` (first-party scripts in this
repo, spawned as real subprocesses by several tests) crashed with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` the moment they reached
`@pdpp/polyfill-connectors/manifests` or other `src/*` subpaths; a real server boot
(`test/run-tests-env-scrub.test.ts`) hit the same crash reaching
`@pdpp/polyfill-connectors/browser-surface-policy`.

Compiled all of `src/**/*.ts` (excluding `*.test.ts`), NOT `connectors/`, `bin/` (beyond
the one entry below), or `bench/` — those weren't confirmed broken and this pass didn't
audit their DOM-lib typing or other risk. `tsc` transitively pulled in and compiled the
handful of `connectors/*/collector-definition.ts` files `collector-registry.ts` itself
imports (unavoidable — they're real dependencies of a `src/` file), and `bin/
local-device-exporter.ts` (confirmed broken separately: it's this package's own `bin`
entry, so any real install of this package as a dependency would hit the same crash
running the installed command). Repointed all 30 `src/*`-mapped `exports` entries plus
`bin` at the compiled `dist/` output; the 7 `connectors/*` subpaths still point at raw
`.ts` source unchanged, since nothing currently spawns those as a subprocess (only imports
them, which `tsx`'s esbuild-based loader handles fine regardless of `node_modules`).

Three packaging-only fixups were needed beyond a plain `tsc` invocation, neither touching
upstream source:
- `tsc`'s emit for a `src/**` + `bin/*` include set produces each compiled file TWICE: a
  flat copy directly under `dist/` (e.g. `dist/manifest-registry.js`) and a correctly-nested
  copy under `dist/src/` (e.g. `dist/src/manifest-registry.js`), for a reason not fully
  diagnosed (not reproduced with `@pdpp/reference-contract`'s simpler, single-`src/`-root
  package, nor with a `src/**` include scoped to just 5 files during an earlier, since-
  superseded pass at this fix). The flat duplicates are deleted before packing; only the
  `dist/src/...`/`dist/bin/...`/`dist/connectors/...`-nested ones ship.
- `runtime/controller.ts` (and 9 other files: `scripts/generate-connector-registry.ts`,
  `scripts/canary/otp-posture.ts`, several tests) derive this package's own root directory
  via `dirname(fileURLToPath(import.meta.resolve("@pdpp/polyfill-connectors/manifests")))`
  — i.e., they resolve the `./manifests` export and take ITS DIRNAME, relying on that
  landing exactly one level below the package root (matching `src/manifest-registry.ts`'s
  original depth: `<root>/src/manifest-registry.ts`, so `dirname` + `..` = `<root>`).
  Pointing `./manifests` at `dist/src/manifest-registry.js` breaks this silently: `dirname`
  + `..` then lands on `dist/`, one level short of the real root, and every one of those 10
  call sites' downstream directory walks (finding `connectors/<name>/index.ts`, the real
  `manifests/` JSON directory, etc.) silently resolves to the wrong place. Caught this via
  a real regression during this fix's own verification (8 newly-failing tests after the
  first version of this re-vendor, all connector-path-resolution-shaped) — NOT caught by
  a plain "does the file import" smoke test, which is why this note calls it out
  explicitly for whoever re-derives this recipe next. Fixed by compiling
  `manifest-registry.ts` a SECOND time, standalone, with `rootDir` scoped so its own output
  lands at the exact same depth as the original (`src/manifest-registry.compiled.js`,
  alongside — not replacing — `src/manifest-registry.ts`), and pointing `./manifests` at
  that file instead of the `dist/src/`-nested one.
- Two `src/` files (`reason-display-messages.ts`, `connector-options-schema.ts`) import
  `readPolyfillManifests` via a RELATIVE specifier (`./manifest-registry.ts`), not the
  `@pdpp/polyfill-connectors/manifests` package specifier -- so their compiled output
  (`dist/src/{reason-display-messages,connector-options-schema}.js`) still imports the
  SIBLING `dist/src/manifest-registry.js` (rewritten by `rewriteRelativeImportExtensions`,
  correctly, as a relative import), not the depth-matched
  `src/manifest-registry.compiled.js` the previous bullet's fix introduced for the
  PACKAGE-SPECIFIER consumers. That sibling copy still has the ORIGINAL depth bug (its own
  `packageDir` resolves to `dist/src/`, so its `manifests/` lookup still lands on the
  nonexistent `dist/manifests/`). Caught this via a SECOND regression during this fix's own
  verification (3 more newly-failing tests, all in `owner-connection-config`-route
  territory, none overlapping the first regression's tests) after the second bullet's fix
  landed. Rather than try to unify the two compiled copies onto one canonical path (every
  relative importer would need rewriting, risking yet another depth mismatch), the real
  `manifests/` directory is copied to BOTH `dist/manifests/` (serves the
  `dist/src/*.js`-relative-import consumers) and left findable at the real package root
  (serves the depth-matched `src/manifest-registry.compiled.js`) -- two copies of the same
  45 read-only JSON files, not a maintenance burden since both are mechanically regenerated
  by this same re-derivation recipe, never hand-edited independently.

**`scripts/generate-static-secret-registry.ts` remains broken and was deliberately NOT
included in this compile.** It has the identical raw-TypeScript-under-node_modules defect
(confirmed: `test/static-secret-setup-runtime-authority-parity.test.ts` spawns it directly,
4 call sites, all crashing the same way) and its direct dependency
(`static-secret-credential-capture.ts`) IS already compiled above, but the script itself
has two further problems specific to being vendored as a dependency rather than run inside
`data-connectors`' own dev checkout: (1) it dynamically `import()`s
`resolve(packageDir, "src/manifest-registry.ts")` -- a runtime-computed string, not a
static specifier, so `tsc`'s `rewriteRelativeImportExtensions` cannot rewrite it to `.js`
(a genuine source-level fix belongs there, e.g. building the path with the right extension
already or emitting `.js` directly); (2) it formats its generated output via
`resolve(packageDir, "node_modules", ".bin", "biome")` -- `@biomejs/biome` is only a
`devDependency` of `polyfill-connectors` in `data-connectors`, so that nested
`node_modules/.bin/biome` never exists once vendored as a dependency elsewhere (it isn't
installed as part of this package's own production dependency graph, and even fixing (1)
wouldn't fix this). Both are genuine upstream defects for `data-connectors` to fix, not
something this repo's vendoring step can paper over — tracked in `data-connectors#67`
alongside the residual gap below.

A residual gap remains, tracked in `data-connectors#67`: `scripts/generate-static-secret-registry.ts`
above, and possibly others not yet found by this repo's test suite, still have the same
underlying defect class in the upstream `data-connectors` package itself — the real fix
there is a proper `build` script covering the package's full runtime-reachable surface
(including making its own scripts genuinely runnable once vendored, not just importable),
not a consumer-side patch like this one. This repo's re-vendor is a stopgap for the files
this repo's own tests actually exercise as subprocesses today, not a general fix.

Re-derivable: `npm pack` the package from `data-connectors` at the pinned commit, extract
it, symlink its declared dependencies (including devDependencies `@types/better-sqlite3`
and `@babel/parser`, needed to typecheck two `src/` files) from an already-`npm install`ed
consumer (or install them directly), add a temporary build tsconfig scoped to
`include: ["src/**/*.ts", "bin/local-device-exporter.ts"]`,
`exclude: ["node_modules", "fixtures", "**/__fixtures__", "**/*.test.ts"]` (same
`noEmit`/`outDir`(`./dist`)/`rootDir`(`.`)/`rewriteRelativeImportExtensions`/`declaration`
settings as the reference-contract recipe above), `npx tsc -p tsconfig.build.json`, delete
any flat-duplicate files directly under `dist/` (keep only the `dist/src/...`/`dist/bin/...`/
`dist/connectors/...`-nested ones). Separately, compile JUST `src/manifest-registry.ts`
again with a second temporary tsconfig (`rootDir: "./src"`, `outDir` anywhere scratch,
`include: ["src/manifest-registry.ts"]` only — this file has zero internal imports, so this
is safe) and copy its output into the package as `src/manifest-registry.compiled.js` (+
`.d.ts`), alongside the original `.ts`, matching that file's original depth exactly (see the
`dirname`-of-`./manifests`-export note above for why this second, depth-matched compile is
required, not optional). Copy the real `manifests/` directory to BOTH `dist/manifests/`
(third bullet above) AND leave it discoverable at its real package-root location (the
depth-matched `src/manifest-registry.compiled.js` finds it there directly, no copy needed
for that consumer). Edit `exports`: all `src/*`-mapped entries point at `dist/src/...`
EXCEPT `./manifests`, which points at `./src/manifest-registry.compiled.js`; `bin` points at
`dist/bin/local-device-exporter.js`; `connectors/*` entries stay unchanged, pointing at
source. Remove both temporary tsconfigs, `npm pack` again. Verify before shipping: every
`exports` subpath actually imports (`node -e "import('@pdpp/polyfill-connectors/<subpath>')"`
from a real consumer with this tarball installed) AND, for `./manifests` specifically, that
BOTH `runtime/controller.ts`'s connector-path resolution (package-specifier consumer) AND
`connector-options-schema.ts`/`reason-display-messages.ts` (relative-import consumers)
still find real manifest/connector files — not just that each file imports without
throwing. The full reference-implementation test suite is the actual regression gate this
fix relied on; a narrower "does it import" smoke test missed both prior regressions.
