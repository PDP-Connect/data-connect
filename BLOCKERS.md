# Remote access release blockers

Evidence artifact: source `0637743a2c8d7a76a9251b18c3b3f31f2bd9e190`, SHA-256 `b00a7ea71b42b1d08fdf58f3e431a4da238416c90b8c0fac976ed6328c8c5ac3`.

The integration is not release-ready. The owner HTTP service, generic screen and release suites are implemented, but the combined gate fails. No live accounts or external exposure were used. The matrix and command output are external evidence artifacts named in the implementation report.

## Public-boundary observations

1. **Proof boot identity.** Call `createGozar({manifest, root, identity:{instanceId:I, bootId:B}, secretBackend, hostCapabilities})`, configure through a draft, then `expose({...query, operationId:O, wait:'verified', approval})`. Expected: the verified subject carries the trusted controller incarnation supplied by the supervisor, with a public way to obtain/register a replacement incarnation. Actual: attached results carry the same instance but a different boot ID. The common journey reaches status, stop and cleanup, then fails `proof_boot_identity_mismatch`. The same failure occurs for real HTTPS execution and both extension fixtures. No host code adopts a boot ID from a provider message or silently substitutes one.

2. **Session execution and durable proof.** For admitted HTTPS session rows, call `expose` with fresh route consent, a host operation ID and a bounded session lifetime. Some operations remain applying beyond the fixture's observation deadline; public cleanup remains uncertain. These are failures, not proof that the runtime is absent. For two durable rows, `ensureRoute` returns an unverified view. The full journey requires verified, current proof. The effects fixtures use published unions and the actual owned gate. A fixture defect and an artifact defect remain possible; these observations do not identify a root cause.

3. **Owner-kept execution.** Some declared HTTP(S) rows still return `setup_required` after the generic setup path. One durable result lacks the operation identity needed to find it in owner state. External owner-kept proof/subject integration is also listed as incomplete in the artifact receipt. These rows cannot receive an executable pass or a refusal-only release waiver.

4. **Detect-only admission.** The two raw-stream entries have detect-only inventory data and no candidate tokens. `expose` with non-authoritative approval refuses with `consent_unknown`, with zero observed effects. The negative test expects an explicit `unsupported` refusal for the detect-only kind and therefore remains failing. They stay in the detect-only scope category; no execution pass is inferred.

5. **Recovery and retained records.** The five attached and five durable recovery checks pass through public enumeration/status/close, including a killed caller before host handle persistence. Session recovery fails. Some rejected operations retain records whose public close reports `route_not_found`; cleanup is unconfirmed and the testing harness can fail to close the retained handle. The gate retains this debt and records the harness failure separately.

6. **Consent changes.** Attached same-generation re-consent and runtime withdrawal with initial-only proof pass. Session and durable re-consent do not complete the required journey. Changing only a fixture's consent-fact data causes the old approval to be refused as `artifact_integrity_failed` rather than the expected `consent_changed`; retained cleanup also fails. Fresh-row rendering in the actual screen is not proven.

7. **Artifact execution.** An offered install action with `installer.execute` denied returns `unsupported` without execution. With execution permitted and a deliberately wrong artifact hash, `runSetupAction` returns `unsupported`, not `artifact_integrity_failed`. The shipped public factory/testing unions do not expose an artifact executor for supplying the test bytes. The hash-mismatch path is blocked; no private executor hook is used. `Action` still omits the frozen artifact/effects fields, so the sole temporary type extension remains in `install-artifact-types.ts`.

## Browser and host integration

Both browser journeys are attempted through the required isolated owner-journey harness. Startup fails at `listProviders({home, owner})`: the namespace maps the root directory's owner to an unmapped UID, and the package rejects that ancestor as an unsafe state path. The browser is never launched. The harness's network/PID isolation and the package's path checks remain intact. The controller-level pending initial stream plus concurrent status/watch negative passes outside that namespace, under the resource governor; it does not prove the screen assertion.

Production startup exposes the owner routes but requires the trusted supervisor to inject one `ReachabilityService`. The factory and host settings/secret bridge types exist. The default launcher has not wired the Tauri keychain, controller-incarnation registration or listener/password/port supervisor bridge. Missing host services report unavailable rather than inventing capabilities. This is an integration gap, not a completed production rollout.

The broader wrong-subject and late-completion negative matrix is not certified. There is no inferred pass for wrong instance, target, generation or controller restart. The release receipt also lists old callers/schema/CLI, binding projections and documentation as incomplete.

## Repository checks

Console tests, reference/console type checks, the console build, focused reducer/projection checks, the effects type check and source/built-browser identifier scan pass in recorded runs. The normal reference suite reports one unrelated failure because its browser revision is absent from the shared cache. No browser is downloaded.

Normal lint fails. It reports existing source/generated-artifact findings and findings in the new code, including archive-installed dependency declarations and style rules. Those findings are not waived by the controller results. The production screen journey, remaining subject negatives and lint must pass before release.

Follow-ons retained by scope: the Tauri keychain bridge, crash-safe legacy-file migration and deletion of native provider modules after migration. Pairing/attach is separate. The old provider-specific console controls and server mutation implementation are removed; the one legacy importer and native modules remain.
