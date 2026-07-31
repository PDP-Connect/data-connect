# Grant

## What this is

- Grant route orchestration for claim/verify/consent/approve/success.

## Files

- `index.tsx`: route composition, loading/error/success selection, debug wiring.
- `use-grant-flow.ts`: main flow orchestration and approve/deny handling.
- `use-browser-status.ts`: browser readiness gate before the flow proceeds.
- `types.ts`: route-local flow/session types.
- `index.test.tsx` and `use-grant-flow.test.tsx`: route and flow coverage.

## Canonical inputs

- `/grant?sessionId&secret&scopes`
- `status=success` forces the success state
- `sessionId` is required (`grant-session-*` indicates demo mode in dev)
- `secret` is required for real session approval/deny flows
- `scopes` can be JSON array or comma fallback
- `appId` may still be present as supplemental context, but it is not the
  canonical authority for a grant session
- `masterKeySig` may be present when auth is restored from a deep link
- `authorizationDetails` carries a PDPP Rich Authorization Request
- `authorizationDetailsSig` is required whenever `authorizationDetails` is
  present

For an external PDPP request, the builder signs this recursively key-sorted JSON
message with EIP-191:

```json
{
  "authorization_details": [],
  "session_id": "relay-session-id"
}
```

The signature must recover to the `granteeAddress` returned by Session Relay.
DataConnect verifies the proof before it renders consent. Missing signatures,
modified authorization details, and signatures copied to another session fail
closed. Existing non-PDPP Session Relay links do not need this parameter.

Prefetched session and builder data passed in `location.state` from `/connect`
is an optimization only. The route still treats URL params as canonical.

## Behavior

1. `/connect` may prefetch the claimed session and verified builder, then route to
   `/grant` with canonical query params and optional prefetched state.
2. If prefetched data exists, `useGrantFlow` skips some or all of claim/verify work.
3. Without prefetched data, `useGrantFlow` claims the session, verifies the builder,
   then enters `consent`.
4. A PDPP request verifies `authorizationDetailsSig` against the claimed builder
   before it enters `consent`.
5. Clicking **Allow** requires auth to already be populated, typically from a deep
   link carrying `masterKeySig`. If auth is missing, the route surfaces an error
   that sends the user to `account.vana.org`.
6. If auth exists but the Personal Server is still starting, the route enters
   `preparing-server` and auto-resumes approval once the port and tunnel are ready.
7. Clicking **Cancel** makes a best-effort deny call for real sessions, then
   navigates home.
8. `status=success` forces the success UI.

## Data-source label

- Example: `["chatgpt.conversations"]` -> `ChatGPT`
- Fallback: "data source" / "data"
- Shared helpers live in `src/lib/scope-labels.ts` and are used by `/connect` and `/grant`.

## Mocking

Use these in the browser when testing the grant flow directly:

- Raw scopes (comma fallback):
  `http://localhost:5173/grant?sessionId=grant-session-123&secret=test-secret&scopes=chatgpt.conversations`
- JSON scopes (what `buildGrantSearchParams` generates):
  `http://localhost:5173/grant?sessionId=grant-session-123&secret=test-secret&scopes=%5B%22chatgpt.conversations%22%5D`
- Success override:
  `http://localhost:5173/grant?sessionId=grant-session-123&secret=test-secret&scopes=%5B%22chatgpt.conversations%22%5D&status=success`

If generating in code, do not encode the full query string:

```ts
const search = buildGrantSearchParams({ sessionId, secret, scopes, appId }).toString()
navigate(`/grant?${search}`)
```
