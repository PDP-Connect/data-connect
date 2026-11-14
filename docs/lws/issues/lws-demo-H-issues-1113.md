# Draft GitHub issues for w3c/lws-protocol — PDPP field- and record-level grants

Prepared for the PDPP team building a protocol for field- and record-level data grants.
Sources: `docs/lws/PLAN.md` and `docs/lws/evidence/` (lws-server-probe.md, lws-spec.md,
dataconnect-change-log.md) in PDP-Connect/data-connect at base `98d6fa07`, and a live search
of the public issues of w3c/lws-protocol on 2026-11-14.

## Existing-issue check

All 155 public issues in w3c/lws-protocol were listed and their titles scanned on
2026-11-14, and the bodies of the closest ones were read. No existing issue covers any
of the three points below. The closest existing issues are cited inside each draft:

- #280 "Access request/grant to container members" (open, 21 Oct 2026) — about granting
  to a changing set of container members, not about selecting fields or records inside
  one resource.
- #303 "ODRL usage with LWS Access Profile" (open, 10 Nov 2026) — proposes ODRL-aligned
  `Asset`/`AssetCollection` targets and asks whether `refinement` should be supported.
- #144 "Potential issues of Authorization Request and Grant being source of truth"
  (open, 27 Apr 2026) — grants as source of truth when several services or mechanisms
  exist, and the effect on user autonomy.
- #230 "Improving Access Requests and Access Grants" (closed, 23 Oct 2026) — asked how
  resource-type constraints relate to type search and whether a request could target the
  storage root with a resource-type constraint; no such target rule is in the pinned text.
- #296 "Is the 'Protected Resource Metadata' too granular?" (open, 2 Nov 2026) — about
  Protected Resource Metadata granularity and GNAP/UMA independence, not about grant scope.

Nothing was posted to GitHub. These are drafts only.

Reference points used in the drafts: LWS protocol pin `db64f56` (9 Nov 2026);
lws-server commit `97e8ace`; probe run 13 Nov 2026 against a jar built from `97e8ace`,
run locally on `127.0.0.1:18091` with a fresh data directory.

---

## Draft 1

### Title

Token endpoint silently ignores `authorization_details` (RFC 9396), so a narrow request returns a full token

### Problem

A client can ask for a narrow slice of data in the token request and get back a token
that allows everything its identity may read, with no error and no sign that the
request was narrowed. A client that believes it asked for one stream, two fields, and
one year gets a token for the whole storage.

The PDPP case: a "music stats" client asks for the `plays` stream only, fields
`artist_names` and `played_at`, time range 2025-01-01 to 2026-01-01, purpose
"music stats". It sends that selection as RFC 9396 `authorization_details` in the
token-exchange request. The server answers 200 and issues a normal token. Nothing in
the token records the selection.

### Reproduction (lws-server commit `97e8ace`)

1. Build lws-server from commit `97e8ace` and run it locally (the probe ran the built
   jar on `127.0.0.1:18091` with a fresh data directory).
2. Sign a subject JWT as in `docs/lws/PLAN.md` (alg EdDSA, `iss = sub = client_id =
   <did:key>`, `aud` = storage root URL with trailing slash) and POST it as
   `application/x-www-form-urlencoded` to `<storage>/.lws/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
   `subject_token=<jwt>`,
   `subject_token_type=urn:ietf:params:oauth:token-type:jwt`,
   `resource=<storage root>`. Call this request A.
3. Repeat the same POST, adding the URL-encoded `authorization_details` value
   (request B):

   ```json
   [{"type": "https://pdpp.org/data-access", "streams": [{"name": "plays", "fields": ["artist_names", "played_at"], "time_range": {"since": "2025-01-01", "until": "2026-01-01"}}], "purpose": "music stats"}]
   ```

4. Decode both access tokens. Both return HTTP 200 with `token_type: Bearer`,
   `expires_in: 300`, `issued_token_type:
   urn:ietf:params:oauth:token-type:access_token`. Both decoded payloads carry the
   same `aud`, `client_id`, `exp`, `iat`, `iss`, and `sub`; only the random `jti`
   differs (`47645072-5c9e-4487-bc63-21df364d934d` vs.
   `4b090f5c-e69a-4921-bc58-f1156b495c38`). No RAR data is reflected in any claim.
   In the server source, `TokenEndpointServlet.java:62-75` reads only form parameters
   and `TokenExchange.java:144-190` mints the token from the required fields.

A JSON request body with the same parameters instead returns HTTP 400
(`invalid_request`, "the body must be application/x-www-form-urlencoded"), so the
form-encoded shape is the correct way to send this; the parameter itself is the
part that is dropped.

### Why it matters

Silent narrowing failure is the worst outcome for a least-privilege client. The
client, the person granting access, and any audit log all see a request for a narrow
slice, while the token in hand is broad. The failure is invisible until someone
decodes the token and compares it with the request. Any team building finer-grained
grants on top of LWS — PDPP included — cannot tell from the token endpoint whether
its selection was honoured.

The pinned protocol text gives no cover here either: it contains no
`authorization_details` term and no RFC 9396 integration (the October 2025 meeting
material lists RFC 9396 as a relevant spec and sketches an example JWT carrying an
`authorization_details` claim, but that material is explicitly a starting point, not
a consensus position). So the server is not violating the spec; the spec is silent
and the server fills the silence by dropping the parameter.

### Proposal / question

Pick one of the two, and say which:

1. **Reject what is not understood.** The token endpoint should reject a
   token-exchange request carrying `authorization_details` it does not support
   (for example `invalid_request` / `invalid_authorization_details`), so a client
   learns immediately that its selection was not applied. This is the safe default
   while no RAR type is defined.
2. **Define an LWS RAR type.** If the group wants RAR in LWS, define the
   `authorization_details` type(s) a server must understand, how the selection is
   reflected in the issued token, and how a server that does not support a requested
   type must answer.

Related issues: none covers this. #296 discusses GNAP/UMA independence and states
LWS "doesn't depend on" GNAP or UMA, which is about the authorization-server baseline,
not about silently dropping a requested selection.

---

## Draft 2

### Title

How should a deployment carry and enforce a selection finer than one resource?

### Problem

LWS grants select whole resources. The smallest portable unit in the pinned Access
Profile is one resource URI: the built-in target matchers are `DataResource`,
`Container`, and `StorageResource`, and the standard constraints (`type`, `format`,
`client`, `purpose`, `dateTime`) constrain whole resources. There is no standard
target form for JSON fields, JSONPath selectors, NDJSON rows, or a query/filter
inside a resource body.

PDPP stores a stream as one NDJSON file (for example a `plays` file holding every
play record). A person wants to share only two fields (`artist_names`,
`played_at`) of that file, for one year. LWS today offers no way to write that
selection down in a grant, and no server behaviour that would enforce it. The only
finer-selection channel PDPP has tried — `authorization_details` in the token
request — is silently ignored (see draft 1).

### Reproduction (lws-server commit `97e8ace`)

1. Build and run lws-server from commit `97e8ace` as in draft 1, and obtain a token
   by token exchange.
2. Store an NDJSON file, for example `PUT /plays.ndjson` with
   `Content-Type: application/x-ndjson`. The server keeps the content type and the
   bytes; it does not parse rows.
3. Try to express "read only `artist_names` and `played_at` from `/plays.ndjson`
   for 2025" as an Access Request. POST an `AccessRequest` JSON-LD document to
   `/.lws/access-requests` as `application/lws+json` (the endpoint works: the probe
   got HTTP 201 with a server-assigned ID for a whole-resource request). There is
   no defined `target` matcher or constraint operand in the pinned profile
   (`lws10-core/lws-access-requests.html`) that names fields or rows inside the
   resource, so the selection cannot be written in the request at all.
4. The same gap shows on the token side: repeat the draft 1 request B with the
   `authorization_details` selection above. The issued token carries no trace of it
   (same claims except `jti`), so the storage has nothing to enforce even if the
   client asks.

Note on scope: the probe tried to compare a grant on one folder with a grant on
another, but the attempted container creation made a normal resource instead of a
container, so folder-target grants are untested here, not evidence for or against
them. This draft is about selection *inside* one resource, which is a separate gap.

### Why it matters

PDPP's data model is field- and record-level: a grant means "these fields of these
records for this purpose and period". If LWS cannot carry that selection, every
deployment that needs it must invent its own side channel, and those side channels
will not interoperate: a grant written by one app will be unreadable — or wrongly
read as a whole-resource grant — by another. The alternative, splitting every
field combination into its own file, pushes access control into file layout and
breaks as soon as a new selection is needed.

### Proposal / question

1. Is ODRL `refinement` the intended vehicle for this? Issue #303 asks whether
   `refinement` should be supported in the ODRL-aligned Access Profile, and
   proposes `Asset`/`AssetCollection` targets. If yes, please give a worked
   example: an Access Request granting `artist_names` and `played_at` of one NDJSON
   resource for a date range, and state what a server that does not understand the
   refinement must do (reject the request, or treat it as a whole-resource grant?).
2. If `refinement` is not the vehicle, what is — a new target matcher type, a new
   constraint operand, or an explicit statement that sub-resource selection is out
   of scope for LWS 1.0 and belongs to the application layer?

Related issues: #280 ("Access request/grant to container members", open) is about
granting to a changing *set of resources* under a container, not about selecting
inside one resource, so it does not cover this. #303 (open) is the nearest
discussion and this draft asks it to answer the sub-resource question directly.

---

## Draft 3

### Title

One place for a person to list and revoke both LWS grants and finer-grained grants

### Problem

A person who grants access through LWS has one listing for LWS grants
(`GET /.lws/access-grants`) and one revocation action (`DELETE /:id`). But a PDPP
deployment also keeps finer-grained grants — the field/record selections from draft
2, which LWS cannot express. Those live outside LWS, in PDPP's own store, with
their own listing and revocation. The person now has two places to look and two
things to revoke, and revoking one says nothing about the other.

Concretely: the person grants a music-stats app read access to one folder through
LWS, and separately grants it the `plays` fields `artist_names`/`played_at` for
2025 through PDPP. They later open the LWS grant list, see one grant, revoke it,
and reasonably believe the app has no access left. The PDPP grant is untouched and
still valid. Nothing in LWS connects the two records.

### Reproduction (lws-server commit `97e8ace`)

1. Build and run lws-server from commit `97e8ace` as in draft 1, and obtain tokens
   for two identities.
2. Identity 2 POSTs an `AccessRequest` JSON-LD document to
   `/.lws/access-requests` as `application/lws+json` (probe: HTTP 201 with
   `Location: /.lws/access-requests/b50bd6ac-73ed-4391-bfa4-2efb354339ce`).
   Identity 1 POSTs an `AccessGrant`; the probe got HTTP 201 with a
   server-assigned ID.
3. Identity 1 GETs `/.lws/access-grants` with `Accept: application/lws+json`. The
   probe got HTTP 200 with a container listing, `totalItems: 1`, item type
   `DataResource, AccessGrant`.
4. Now add the PDPP-side finer grant for the same app and purpose (the
   field/record selection from draft 2, which cannot be written as an LWS grant).
   List the LWS grants again: the listing still shows `totalItems: 1`. The PDPP
   grant appears nowhere in it and has no LWS identifier to revoke.
5. Revoke the LWS grant with `DELETE /.lws/access-grants/:id` (the defined
   revocation action). The PDPP grant is unaffected; there is no defined cascade,
   link, or shared identifier between the two records.

### Why it matters

Revocation is the person's main control after granting. If granting happens in two
systems and revocation in only one of them is visible, the person will believe
access is gone when it is not. This is the same split that issue #144 warns about:
grants as a source of truth get hard when there are several granting services or a
mechanism more capable than the access-control language, and a user can end up
locked into a client's permission-seeking logic instead of their own choices. A
deployment that adds finer-grained grants on top of LWS without answering this
question ships a revocation gap by default.

### Proposal / question

1. Should the Access Grant listing be the single place a person sees *all* grants
   affecting their storage, including finer-grained ones made outside LWS? If so,
   what must a finer-grained grant do to appear there — for example, must it be
   recorded as an LWS grant with its selection in an extension, and must revoking
   the LWS record revoke the finer one?
2. If the LWS listing is *not* that place, say so explicitly, and say what the
   owner-facing alternative is: a discovery mechanism for the other grant store, a
   link from the LWS grant to the external grant, or a requirement that a
   deployment present one combined view to the person.

Related issues: #144 (open) captures the multi-service source-of-truth concern
this draft is an instance of, but asks about grants in general, not about a person
listing and revoking across LWS and a finer-grained system. #230 (closed) improved
Access Requests and Grants without adding a cross-system listing. No existing issue
asks for one place to list and revoke both kinds of grant.
