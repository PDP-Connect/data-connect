# Remote access release blockers

Evidence: source `5e4c0112aa3d7615ef9cfae4ca753c9b905bacb1`, archive SHA-256 `1e1a6683c08c94513a5e0f1a1ee62d6b3e48ab173f364ff268c29a6bc9b3d201`. The aggregate remains FAIL. No live accounts, external exposure, private imports or canned proof were used.

In call shapes below, H is an owned test home, P an inventory key, T the real owned application, I/B supervisor identity strings and O a fresh operation key. Actual inputs, subjects and observations are retained in the external report's matrix and logs. Scope, digest and token always come from current public snapshots.

## Owner-confirmed library defects: assertions unchanged

1. **A1: boot identity (library).** Call `createGozar({manifest,root,identity:{instanceId:I,bootId:B},secretBackend,hostCapabilities})`, configure/commit public drafts, then `expose({...query,operationId:O,wait:'verified',approval})`. Expected: `verification.subject.instanceId === I` and `bootId === B`. Actual: I agrees but B differs on attached/session routes. The full journey reports `proof_boot_identity_mismatch`; DataConnect does not substitute an identity.

2. **A2: locked draft (library).** After approved clear/staged rotation, lock the backend and call `readConfigurationDraft({home:H,owner,providerId:P,draftId})`. Expected: retained credential observations with `known:false`, reason `secret_backend_locked`. Actual: `configuration.credentials` is empty. The assertion remains failing.

3. **A3: retained cleanup (library).** Call `listRoutes({home:H,owner})`, then `closeRoute({home:H,handle,mode:'remove'})` on a valid returned handle, including terminal/recovery records. Expected: publicly closeable/replayable current ownership or explicit unconfirmed recovery, never fabricated absence. Actual: durable close/replay can throw `route_not_found` / `No retained ownership record exists for this route handle`; rejected reservations can also retain unconfirmed cleanup. Both managed durable matrix rows now fail `cleanup_debt` after verified startup. A route with cleanup debt is never counted as a pass. Kind-mismatch zero-effect assertions complete but their full test fails on retained cleanup. The old and fresh factory new-fact assertions also complete; both final cleanup attempts fail.

4. **A4: detect-only refusal (library).** Call `expose` for each declared raw-stream detect-only query with non-authoritative route approval. Expected: `unsupported` before token redemption, zero effects. Actual: `consent_unknown`, zero effects. Both negatives remain failing and outside executable HTTP(S) scope.

## B: public-only startup attribution

Each row has a runnable Node entry under `reference-implementation/test/fixtures/reachability/minimal/`. The external report names the forwarding directory containing an isolated copy, archive installer and adjacent log for every entry. These scripts import only public Gozar APIs, the public testing factory and local effect data; no DataConnect service, owner HTTP API or UI participates. The real local application installs public `createServiceVerifier`. All proof fetches/exchanges reach its owned gate.

| Entry | Standalone result | Attribution |
|---|---|---|
| `tailscale-funnel-session.mjs` | Verified, cleanup confirmed | DataConnect-fixed: empty startup output prevented fixture collection from completing; actual child exit now withdraws its readback. Full matrix still fails A1. |
| `tailscale-private-session.mjs` | Verified, cleanup confirmed | DataConnect-fixed: same fixture defects; full matrix still fails A1. |
| `tailscale-funnel-durable.mjs` | Verified, cleanup confirmed | DataConnect-fixed: real application verifier, exact owned direct-target routing and HTTP authority preservation. Full matrix retains A3 cleanup debt. |
| `tailscale-private-durable.mjs` | Verified, cleanup confirmed | DataConnect-fixed: same direct proof defects; full matrix retains A3 cleanup debt. |
| `own-address-durable.mjs` | Verified, cleanup confirmed; external handle generation 0 | DataConnect-fixed proof fixture and encoded opaque handle URL paths. The strict full matrix now exposes the generation defect below. |
| `ngrok-https-edge-attached.mjs` | Verified, cleanup confirmed | DataConnect-fixed: preserve measured individual stream chunks/gaps from the actual gate. Full matrix still fails A1. |
| `lan-session.mjs` | Catalog offers no token after all setup is complete | Library-boundary failure, owner attribution pending; exact call below. |
| `own-address-session.mjs` | Catalog offers no token after all setup is complete | Library-boundary failure, owner attribution pending; exact call below. |

The session repro's old fixture still exceeded a separate 90-second bound. The DataConnect observer uses 20 seconds; a declared recipe create alone can consume 20 seconds, with additional probe deadlines. No observer deadline or proof assertion was loosened. After emitting source-shaped startup bytes, the actual public session calls verify in about five seconds under the original observer bound. Regression logs record the failing fixture before each correction and passing real-gate assertions afterward.

For both remaining setup rows, call `listProviders`, `beginConfigurationDraft`, each offered required input/action using `input.actionId`, fresh draft reads and `commitConfigurationDraft`, then refresh inventory and call:

```js
catalogRoutes({schemaVersion:1, home:H, owner:'fixture-owner', providerId:P,
  target:T, usage:{kind:'session',lifetimeMs:120000},
  requirements:{reach:R,transport:X,payloadAccess:'allow-provider',
    address:'any',setup:'allow',protocols:[]}})
```

For `lan`, R is `lan`, X is `any`: no declared input or setup action remains. For `own-address`, R is `internet`, X is `https`: its declared `origin` input/action completed with `https://fixture.invalid`; no required input remains. Expected: an admitted, completely configured candidate offers a token or a structured actionable prerequisite refusal. Actual: `eligible:false`, `candidateToken:null`, setup state `unknown`, unmet `{requirement:'setup',actual:'unknown',reasonCode:'unknown'}`. The scripts fail at that token assertion before any expose call. The corresponding service journey reports `setup_required`. Full exact inputs and effect records are in each script's log.

## Additional failure and remaining contract evidence

**Initial external generation (library-boundary failure, not yet owner-confirmed).** Public `ensureRoute({...query,operationId:O,wait:'verified',approval})` on the owner-kept durable row returns a verified external handle with `generation:0` and subject `handleGeneration:0`. Expected: both 1 on new admission. The standalone log records the values; the full matrix fails `initial_route_generation_mismatch` on both unchanged assertions. No offset or special case is added.

**C: registry fact change (contract correction).** Registry identity hashes content. The old factory rejects earlier approval as `artifact_integrity_failed`, with zero starts. A fresh artifact deployment/factory/catalog with identical adapter JavaScript exposes the new fact and digest. Old digest approval is rejected with zero effects; fresh digest approval verifies. The actual browser shows the new row and completes verified/stop. This replaces the old `consent_changed` expectation and is not a waiver. The controller test still fails final A3 cleanup; none of its positive semantic assertions is relaxed.

**Extended fixture contract coverage remains failing, not certified.** Session fake-registry recovery cases cannot establish their allocation or cleanup premise; session/durable same-generation re-consent cases fail startup proof or cleanup. Runtime-drift testing reads an enumerated historical view with `published:null` and cannot establish initial publication. Those are unproven fixture/public-contract assumptions, distinct from confirmed A1–A4. No release credit is given, and no host workaround or weaker proof assertion is introduced. The report records each failing case and attribution as contract/unsettled rather than claiming a proven library cause.

## Browser and host corrections

Both actual Playwright journeys now pass. The private network/PID namespace constructs a root and home ancestry with mapped owners, and public inventory runs through the unchanged Gozar home-safety check. The namespace regression verifies loopback-only interfaces. No browser download or isolation fallback was used.

Production bootstrap now forwards its trusted reachability service into the resource server; its authenticated HTTP regression fails before and passes after the one-line fix. The console fetches current state immediately when an operation completes. The unknown-provider journey shows the added fact, synthetic-proof label, verified state and confirmed stop. The buffered initial stream journey proves concurrent status/watch cannot publish or display verified.

The Tauri keychain bridge, legacy-file migrator and Rust provider-module deletion remain follow-ons. The production supervisor still must supply real capabilities, custody, controller identity and listener/password policy. Pairing/attach is out of scope. Normal repository lint and the unrelated missing cached browser revision in the historical full reference suite remain recorded in the external report.
