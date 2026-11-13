# Reachability release preflight

This is incomplete release-gate scaffolding. It does not implement Remote access.

Install only a checksummed local tarball:

```sh
GOZAR_TARBALL=/path/to/package.tgz GOZAR_TARBALL_SHA256=<sha256> node scripts/reachability/install-tarball.mjs
GOZAR_COVERAGE_MATRIX=/path/to/coverage-matrix.json node --test scripts/reachability/contract-preflight.test.mjs
```

The installer checks the checksum before invoking installation and refuses installation without disk headroom above 100 GB. It does not change the dependency manifest or lockfile. Repeat after dependency restoration. Dependency lifecycle scripts are disabled for this artifact preflight; normal project gates still need their normal build setup.

The preflight writes all declared executable provider/usage pairs as blocked. It fails on absent embedding methods, and continues to fail until the actual owner HTTP/controller/browser integration exists. It cannot certify a release.

`testing-effects.mjs` is the only harness seam. Callers supply an array of `{kind, operation, handle}` entries using the published operation vocabulary. No provider dispatch or unknown-effect fallback is permitted.

Setup and route approvals are distinct contracts. Setup has no route token or query fields; route approval requires a fresh exact catalog. The two mismatch tests and approval cards remain to be implemented. See the root blocker record.
