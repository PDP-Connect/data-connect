# Vendored cross-repo dependency tarballs (transitional)

## `@pdpp/reference-contract` — pinned tarball, not a registry release (Move B decision Q2, interim)

Move B's own decisions doc asked for either a published, pinned npm release, or a
generated snapshot. A real `npm publish` needs registry credentials this move did not
have available, so this pins the same way `PDP-Connect/pdpp`'s own `vendor/` directory
already pins `@pdpp/collector-runtime` and `@pdpp/connector-protocol` from data-connect
(see that repo's `vendor/README.md` for the precedent this mirrors) — a committed tarball
built with a plain `npm pack`, referenced via a `file:` dependency, with its digest
recorded below.

`pdpp-reference-contract-0.1.0.tgz` was built via `npm pack` from
`packages/reference-contract` at `PDP-Connect/pdpp` commit
`0d3deca19186a2185a6a15ab76c71352d10e627e` (`main`, 2026-09-02). The package ships raw
TypeScript source with no build step (`main`/`exports` point directly at `./src/*.ts`),
so the tarball is a straight `npm pack` of the package directory — no prepack/build
mutation applied. SHA-256 is recorded in `SHA256SUMS` in this directory.

`reference-implementation/package.json` depends on it via
`"file:./vendor/pdpp-reference-contract-0.1.0.tgz"`.

**Swapping to a real registry release is a one-line change** once the owner publishes
`@pdpp/reference-contract`: replace the `file:` path in
`reference-implementation/package.json` with the published semver range (e.g. `^0.1.0`),
delete this tarball and its `SHA256SUMS` line, run `npm install`. No other code changes
are needed — the package's public surface (all 9 `exports` subpaths) is unchanged
between this tarball and the source it was packed from.

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
