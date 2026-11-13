# Remote access integration blockers

Implementation is incomplete. The existing Remote access screen and server remain in place. The artifact preflight is deliberately failing; it is not the requested HTTP/controller/browser integration test.

## Installed artifact lacks embedding methods

Source pin: `ca786f98465a5b4d6d230c42a2cc14f2c0119995`.
Tarball SHA-256: `98edab7a030f75e500ef09342cba28257a0131e0d965c127787d5577d146dbd6`.

Exact call: `const api = createGozar()` from the installed package's public root.
Input: no options (default trusted registry).
Expected: the factory exposes all frozen public embedding methods.
Actual: `typeof api[name]` is `undefined` for `listProviders`, `beginConfigurationDraft`, `commitConfigurationDraft`, `discardConfigurationDraft`, `storeSecret` and `discardSecret`.
No method is emulated by the host.

The preflight reads the installed manifest and definition data to account for 13 declared executable provider/usage pairs. This is a blocked artifact audit, not a substitute for enumeration through `listProviders` or lifecycle execution.

## Effects harness and vocabulary

The published signature is `createTestingGozar({effects, ...createGozarOptions}) -> {gozar,events,close}`. The local seam uses only that public export and passes effect fixtures as exact kind/operation entries. The integrated tarball and operation vocabulary have not arrived. No real-adapter effects have run.

## Disk floor

Available disk fell from 107,000,811,520 bytes at entry to 98,764,771,328 bytes. The dependency installation was terminated. Builds, browser installation and normal gates were stopped. Only artifacts made by this lane are removed during closeout.

## Work still required

- Node service, real host secret backend seam and detached controller/canary test.
- Owner HTTP API, authentication/CSRF integration and allowlist projections, including the existing GET config leak.
- Generic Remote access screen and deletion of replaced provider code.
- Separate setup-scope and route-scope approval cards.
- Both kind-mismatch zero-effect tests against the installed controller.
- Fixture unknown-provider DOM journey; source/bundle independence scan.
- Full lifecycle tests, runtime consent withdrawal, proof subject fencing, revision/rotation tests, installer integrity and cleanup recovery.
- Normal reference and console tests, typecheck and lint.

No acceptance item above is claimed proven. The artifact preflight must be replaced or completed when the real owner journey exists; its final assertion prevents an artifact-only check from becoming a false release pass.
