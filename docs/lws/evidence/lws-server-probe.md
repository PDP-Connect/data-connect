# lws-server live probe report

Probe target: existing jar built from commit `97e8ace`, run as `lwsderisk-main` on `127.0.0.1:18091` with a fresh probe data directory. All requests were local. The container was removed after probing. Scripts and captured output are in this directory; `probe.py` captured the first pass and `final-probes.py`/`large_and_extra.py` captured follow-ups.

## 1. RFC 9396 authorization_details

Request A and B were POSTs to `/.lws/token`, `Content-Type: application/x-www-form-urlencoded`, with the same RFC 8693 fields and identity 1 credential. B added the URL-encoded `authorization_details` value:

```json
[{"type":"https://pdpp.org/data-access","streams":[{"name":"plays","fields":["artist_names","played_at"],"time_range":{"since":"2025-01-01","until":"2026-01-01"}}],"purpose":"music stats"}]
```

Both returned HTTP 200, `Content-Type: application/json;charset=utf-8`, `Cache-Control: no-store`, `Pragma: no-cache`. Both returned `token_type: Bearer`, `expires_in: 300`, and `issued_token_type: urn:ietf:params:oauth:token-type:access_token`. Decoded payload A:

```json
{"aud":"http://127.0.0.1:18091/","client_id":"[synthetic DID redacted]","exp":1794613041,"iat":1794612741,"iss":"http://127.0.0.1:18091","jti":"47645072-5c9e-4487-bc63-21df364d934d","sub":"[synthetic DID redacted]"}
```

Decoded payload B has the same `aud`, `client_id`, `exp`, `iat`, `iss`, and `sub`, and a different random `jti` (`4b090f5c-e69a-4921-bc58-f1156b495c38`). Thus the supplied RAR parameter is accepted but ignored; no RAR data is reflected into claims. JSON request body with the same OAuth parameters and RAR returned HTTP 400, `Cache-Control: no-store`, `Pragma: no-cache`, JSON error `invalid_request`, description `the body must be application/x-www-form-urlencoded`.

The exact tokens differ because each issuance has its own JTI and signature, not because of authorization_details. `TokenEndpointServlet.java:62-75` reads only form parameters and copies all parameters into a map; `TokenExchange.java:144-190` selects/exchanges on the required fields and mints the token. The endpoint rejects non-form media types at `TokenEndpointServlet.java:64-66`.

The requested “one folder only” comparison was not established: my attempted container creation made a normal resource (`Location: .../one-2`), and the parent-container check rejected children. The resulting grants targeted a nonexistent container and could not establish differentiated reads. Initial ID2 GETs of all targets therefore returned 404. This part is untested, not evidence that RAR grants or folder access work.

## 2. Access Requests and Grants

With the server default `lws.access-requests.enabled=true` (example config line 227), identity 2 POSTed a valid `AccessRequest` JSON-LD document to `/.lws/access-requests` as `application/lws+json`; response was HTTP 201 with `Location: http://127.0.0.1:18091/.lws/access-requests/b50bd6ac-73ed-4391-bfa4-2efb354339ce`, `Content-Type: application/lws+json;charset=utf-8`, `Cache-Control: private, no-store`. The body carried the submitted access policy and server-assigned ID. Identity 1 POSTed a valid `AccessGrant`; response was HTTP 201 with a grant `Location` and returned JSON-LD with the same policy and server-assigned `id`. Identity 1 GET `/.lws/access-grants` with `Accept: application/lws+json` returned 200 and a container listing with `totalItems: 1`, item type `DataResource, AccessGrant`, format `application/lws+json`.

The probe’s attempted grant target was `/one/` where no such container existed, so this run did not demonstrate successful access followed by revocation using a working token. It did DELETE the grant record successfully (204), but ID2’s post-delete GET was 404 and its pre-delete GET was already 404. The source describes revocation as immediate removal (`AccessService.java:38-49`); that specific end-to-end effect was not validated here.

Target granularity from `AccessService.java:43-46, 556-580`: a policy can name one IRI (a single data resource) or a container IRI (covering descendants); `StorageResource` matcher covers any resource, while `DataResource` and `Container` restrict target kind. Nothing finer than one resource is named as a grant target. Conditions are constraints, not sub-resource field filtering.

Purpose and expiry are expressible as supported access-profile constraints: source comment names `dateTime`, `client`, `format`, `type`, and `purpose` (`AccessService.java:46-49`); evaluation is fail-closed for unknown operands/operators (`AccessService.java:640-655`). This run did not send purpose/dateTime constraints in a grant. Extra top-level fields were not tested for persistence; `normalize` builds a canonical JSON object (`AccessService.java:796-840`), so do not assume arbitrary extension properties survive without a direct round trip probe.

## 3. Login suites and token behavior

GET `/notthere` without credentials returned 401 with `WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1:18091/.well-known/oauth-protected-resource/notthere", as_uri="http://127.0.0.1:18091", realm="http://127.0.0.1:18091/"` and a Link to the storage root. The OAuth protected-resource metadata endpoint returned 200 with `authorization_servers:["http://127.0.0.1:18091"]`, `bearer_methods_supported:["header"]`, DPoP algorithms, and `dpop_bound_access_tokens_required:false`.

The storage description is at the storage URI `/`; `StorageDescriptionService.java:205-224` builds it. Its source advertises OpenID and self-signed controlled identifier suites, with SAML only when an IdP certificate is configured (`StorageDescriptionService.java:77-86`). The live root response observed in this pass was a paged container listing rather than the storage description, so the exact rendered suite list was not captured from the live body. Suite names from source: `https://w3c.github.io/lws-protocol/lws10-authn-openid/` and `https://w3c.github.io/lws-protocol/lws10-authn-ssi-cid/`; no SAML issuer was configured.

A signed did:key credential with `kid` exchanged successfully (200). A second valid EdDSA did:key credential with the `kid` header omitted also exchanged successfully (200). So did:key is accepted by the self-signed controlled identifier validator and `kid` is not required for this credential. No refresh token was returned: successful response contained only `access_token`, `issued_token_type`, `token_type`, and `expires_in`. The endpoint response builder is `TokenEndpointServlet.java:90-98`; issued access tokens last 300 seconds in this probe.

## 4. Conditional requests, size limits, and concealment

- Existing resource `PUT /nd.jsonl` returned 201 and strong ETag `"bb157861a164e35c"`. `PUT /nd.jsonl` with `If-Match: W/"bb157861a164e35c"` returned 204 (weak form accepted for writes by this implementation). A stale `If-Match: "stale"` returned 412. `If-Match: *` on missing `/missing` returned 412.
- Conditional DELETE with a stale tag returned 412. Conditional DELETE with the current tag returned 204. The first draft’s “current” delete used a tag made stale by an intervening write; the follow-up explicitly fetched and used the current tag.
- PUT body sizes were measured as bytes, `Content-Type: application/octet-stream`: 10 MiB returned 201 in 0.526 s; 60 MiB returned 201 in 0.549 s; 70 MiB ended in client `BrokenPipeError` after 0.006 s, with no HTTP status or response headers available. Follow-up GET `/` returned 200, so the server remained up. Default `lws.max-request-bytes` is 67,108,864 (64 MiB), config line 260; `HttpSupport.java:330-332` constructs 413 for an over-limit body. The 70 MiB request likely hit that body limit before the client finished sending, but the HTTP 413 itself was not observed.
- For authenticated identity 2 without access, GET of the existing `/outside.txt` and missing `/missing.txt` both returned 404 with `Content-Type: application/problem+json;charset=utf-8`. No response header distinguished them. The Problem Details body repeats the requested IRI in `detail`; the URL/resource identity can therefore differ, but there is no distinct status/header signal. `ResourceService.java:1645-1653, 1657-1680` describes masking behavior.
- ETags observed were quoted without `W/` (strong syntax). Replacing `/etag` with identical bytes yielded the same ETag both times (`"0967115f2813a354"`), so it is content-derived and does not change on every write. Source for write conditions is `ResourceService.java:404-463, 719-781`; `IfMatch.java:24-46, 96+` handles matching.

## 5. Content types and describedby/linkset

PUT `/nd.jsonl` with `Content-Type: application/x-ndjson` returned 201; GET returned 200 with the same `Content-Type: application/x-ndjson`, and the exact bytes `{"x":1}\n`. Root listing source/body showed each item can carry a `format`; live root listing reported `outside.txt` as `format:"text/plain"`. The live list request was 200 with `Content-Type: application/lws+json;charset=utf-8` and `Vary: Accept`.

A PUT carrying `Link: <.../schema.json>; rel="describedby"` returned 201, but GET of `/linked.ndjson.meta` showed only automatically generated links (`type`, `up`, `linkset`, storage); the `describedby` relation was absent. The server source documents that client-supplied metadata is applied through `Prefer: set-linkset` (`HttpSupport.java:364+`), not merely a Link header on PUT. I did not retry with that preference and linkset payload, so client-authored describedby metadata remains unverified rather than unsupported.

## Not tested / limits

- Functional folder-target grant (including inside/listing/outside access) and old-token denial after a genuinely successful grant, because the attempted folder creation produced a resource rather than a container.
- Storage-description rendered suite body; source identifies the advertised suites, but root negotiation in this run returned a container listing.
- Persistence/drop behavior of arbitrary extra AccessRequest/AccessGrant fields.
- Successful purpose/dateTime grant constraints.
- A received HTTP response for the 70 MiB body; client-side BrokenPipe occurred during upload.
- A successful user-supplied `describedby` linkset using `Prefer: set-linkset`.

## Six findings for a JSON-records / separate-PDPP-grants design

1. RFC 9396 `authorization_details` can be sent to token exchange and silently has no effect on the issued token.
2. JSON token-exchange bodies fail; clients must send form encoding.
3. LWS grants can name a whole resource or container, but do not provide field-level record filtering.
4. Grant expiry and purpose are constraint concepts; they do not turn a storage grant into per-field enforcement.
5. Non-RDF content types such as `application/x-ndjson` survive PUT, GET, and listing as resource format metadata.
6. Strong-looking ETags are content-derived: identical bytes retain the same tag, and the server accepts a weak `If-Match` on PUT.
