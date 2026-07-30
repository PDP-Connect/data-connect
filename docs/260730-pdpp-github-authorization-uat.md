# PDPP GitHub authorization UAT profile

This local adapter persists a verified GitHub authorization detail, an
immutable grant snapshot, and only the hash of its opaque Bearer token.
Resource reads resolve the token locally and enforce the persisted grant on
every request.

## Access lifetime

`single_use` means one client-token issuance from one approved consent request;
the request is consumed transactionally, so a second issuance cannot succeed.
It does not consume an individual record read. The Personal Server gives that
single issued token a bounded lifetime, eight hours by default. Operators may
set `PDPP_SINGLE_USE_ACCESS_EXPIRES_IN_SECONDS` to a positive whole number of
seconds before starting the Personal Server.

The expiry is stored with both the immutable grant and its token. After expiry,
private Resource Server resolution and redacted public introspection return
`{ "active": false, "inactive_reason": "grant_expired" }`. `continuous`
external grants remain valid until revoked. Local Timeline is a separate,
server-issued continuous grant with its existing eight-hour bound.

## Scope

This is a narrow GitHub UAT adapter. It accepts one `authorization_details`
entry for `https://pdpp.org/data-access` when its source, streams, fields,
views, resource selectors, and time ranges fit the hash-verified installed
connector manifest. It does not replace the Vana Gateway/Web3 grant or Session
Relay approval flow.
