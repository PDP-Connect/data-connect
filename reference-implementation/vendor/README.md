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
