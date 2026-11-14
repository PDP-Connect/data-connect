# Remote access release blockers

Evidence: source `5e4c0112aa3d7615ef9cfae4ca753c9b905bacb1`, archive SHA-256 `1e1a6683c08c94513a5e0f1a1ee62d6b3e48ab173f364ff268c29a6bc9b3d201`. The installed public types compile. The combined journey fails. No live accounts or external exposure were used.

The external implementation report names the complete matrix, commands and logs. In the calls below, H is a private test home, P is the inventory provider key, T is the owned application target, I/B are supervisor identity strings and O is a fresh operation key. Approvals always come from current public snapshots; no scopes or consent digests are reconstructed.

## Observed public-boundary failures

1. **Controller identity.** Call `createGozar({manifest,root,identity:{instanceId:I,bootId:B},secretBackend,hostCapabilities})`, configure/commit through public drafts, then `expose({...query,operationId:O,wait:'verified',approval})`. Expected: proof subject identity survives the controller boundary, or a public supervisor registration path supplies its replacement incarnation. Actual: verified routes carry I but a different boot ID. The common journeys complete their remaining assertions and then fail `proof_boot_identity_mismatch`. The matrix retains expected identity, returned subject and generation assertions. No host substitution is made.

2. **Session startup and durable proof.** Through the owner HTTP API, submit `POST /operations` with a fresh route review, its digest, `kind:'route'` and disconnect acknowledgement. The service calls `expose` for session usage and `ensureRoute` for durable usage. Expected: the admitted HTTP(S) pair completes the common journey with current proof. Actual: two session operations exceed the 20-second observation bound; three durable rows return `verification.status:'unverified'`. Other owner-kept rows return `setup_required` at review. These are observed failures, not a settled attribution to the library: a remaining fixture defect is possible. A default-HTTPS-port fixture mismatch was independently reproduced and fixed; these results are from the rerun after that fix.

3. **SDK publication.** For the admitted attached HTTPS row, generic setup/commit/review succeeds, then `expose({...query,operationId:O,wait:'verified',approval})` returns `verification_failed` with message `The route did not pass publication validation and was withdrawn`. Expected: a synthetic witness from the real owned gate permits the admitted common journey. No canned proof or host publication override is supplied.

4. **Locked draft custody.** Begin a draft, approve `clearConfigurationInput`, stage replacement bytes with the current offered action, lock the fake backend, and call `readConfigurationDraft({home:H,owner,providerId:P,draftId})`. Expected: credential observations remain present as `known:false`, reason `secret_backend_locked`. Actual: `configuration.credentials` is empty. The test refuses to interpret that as an absent credential. Applied inventory locked-custody assertions also run in the common journeys that reach them.

5. **Recovery and cleanup.** Attached operation enumeration, concurrent same-key replay, conflict refusal, stopped replay and unavailable-inventory checks pass. Session allocation/recovery cases fail. Durable crash recovery and stopped replay reach `closeRoute({home:H,handle,mode:'remove'})`, which can return `route_not_found` / `No retained ownership record exists for this route handle`; absence remains unknown and cleanup debt is retained. Rejected wrong-kind and changed-registry operations can also leave records that public cleanup cannot confirm. The wrong-kind zero-effect assertions complete, but their full test fails on cleanup. No private state scan substitutes for enumeration.

6. **Consent changes.** Attached same-generation review/approval passes. Session and durable cases fail startup, proof or cleanup. The runtime-drift extension test does not establish its initial published state, so withdrawal and unsupported refresh are not certified by that integration run. Editing only a fixture definition's added consent fact, then redeeming the earlier approval, returns `artifact_integrity_failed`; the test expects `consent_changed` and a fresh public snapshot containing the new row. The changed registry is rejected, but the complete new-fact journey remains unproven. No inventory facts fill a setup snapshot, and no consent digest is recalculated by the host.

7. **Detect-only redemption.** Both raw-stream entries remain visible, detect-only and tokenless. Call `expose` with the detect-only query and non-authoritative route approval. Expected: explicit `unsupported` refusal with zero effects. Actual: `consent_unknown`, with zero effects. This negative remains failing; the rows remain detect-only, outside executable release scope.

## Confirmed corrections and remaining acceptance

Fresh-route handle and proof-subject generation assertions now pass wherever the common journey reaches them. The superseded b830 archive returned generation 0; that known library defect is retained only as history. DataConnect does not normalize or offset generations.

The pending initial stream proof plus concurrent status/watch test passes on this archive, including cleanup. Installer host refusal and hash mismatch execute nothing; approved matching bytes execute once through the public testing boundary. The SDK safe-error negative also returns a structured owner failure with unpublished proof and retained cleanup action; uncertain allocation remains `unknown-possibly-live`, and harness close reports `cleanup_debt`. The last local artifact type extension is deleted. Required `verification.subject`, `verification.observedAt` and `cleanup.nextAction` keys survive allowlist projection, including null observations.

A missing ownership record keeps the lifecycle unknown with unconfirmed cleanup, even after an earlier confirmation. The screen shows that debt. Host confinement remains an independent observation; the service never infers local confinement from a library cleanup acknowledgement.

The broader wrong-instance/target/generation/restart and late-completion controller matrix is not certified. The actual screen's synthetic-proof label and added-fact journey are authored but not browser-proven.

## Browser, host and repository gaps

Both Playwright journeys are attempted through the existing isolated owner-journey harness and shared browser cache. Startup fails at `listProviders({home,owner})`: the namespace exposes the root ancestor with an unmapped owner, and Gozar rejects the state path as unsafe. Chromium does not launch. Neither path validation nor network/PID isolation is bypassed.

The production launcher still needs the trusted supervisor to inject the long-lived service and wire controller identity, listener/password/port policy and secret custody. The typed bridge reports missing services as unknown/unavailable. The Tauri keychain bridge, legacy-file migration and native provider-module deletion remain follow-ons. Pairing/attach is out of scope.

Normal lint fails across existing source/generated artifacts. Targeted ESLint for the reachability implementation passes in the recorded run. The full reference suite fails one unrelated browser-profile test because its required browser revision is absent from the shared cache; no browser is downloaded. The final report records the console suite, build, type checks, focused assertions and exact command results.
