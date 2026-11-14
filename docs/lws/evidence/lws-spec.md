# LWS protocol research for PDPP storage pairing

**Research cutoff:** 13 November 2026. **Normative text pin:** [`w3c/lws-protocol` commit `db64f561e417339e06a6c4bf513270bae0f5a7f2`](https://github.com/w3c/lws-protocol/tree/db64f561e417339e06a6c4bf513270bae0f5a7f2), committed 9 November 2026. File paths below refer to that tree. The fetched `main` branch was still exactly this commit at the cutoff; PRs listed in §7 are not merged into it.

This is a source audit, not an implementation conformance review. I read the pinned protocol and its suite drafts; retrieved the open/closed issue and PR inventories and comments with `gh`; then read the records matching the requested topics and followed their relevant linked threads. I searched the inventories and source tree for RAR, ZCAP, GNAP, field/record, JSON, transaction, replay and implementation references. I also checked the October 2025 meeting artifacts, W3C Working Group publications/activity/charters/minutes, the W3C LWS use-case and charter repositories, and the linked `lws-contrib/lws-test-suite`. No posts, comments, reactions, or other remote writes were made.

## 1. Access Requests and Access Grants

### Scope and smallest unit

The model’s `target` is an object with a matcher `type` and one or more URI `value`s. The pinned file [`lws10-core/lws-access-requests.html`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/lws-access-requests.html) defines three built-in matchers:

> “`https://www.w3.org/ns/lws#DataResource` — matches resources of type `lws:DataResource`.”
>
> “`https://www.w3.org/ns/lws#Container` — matches resources of type `lws:Container`.”
>
> “`https://www.w3.org/ns/lws#StorageResource` — matches any Storage Resource.”

The `value` collection contains URIs. Therefore the smallest portable unit explicitly represented by the built-in profile is an individual LWS resource URI (a `DataResource`, or a container resource). There is no standard target form for JSON fields, JSONPath/JMESPath selectors, NDJSON rows, byte ranges, or an arbitrary query/filter. A server “MAY support additional type values,” so additional matchers are possible by extension, but they are not interoperable core behavior.

Resource-type and media-type constraints are available, but they constrain whole resources. A server advertising the ODRL Access Profile MUST support `type`, `format`, `client`, `purpose`, and `dateTime` constraint operands. For example, `type` checks type URLs in a resource’s HTTP `Link` headers; `format` checks the media type. The text does not define a field/record selector within the resource body.

The read operation does require HTTP byte-range support for data resources (`Range`/206), but that is partial transfer of a resource after authorization; it is not a grant target or access-control scope for a portion of the resource.

The boundary around containers is unsettled. Open issue [#280, “Access request/grant to container members” (opened 21 October 2026)](https://github.com/w3c/lws-protocol/issues/280) says:

> “Actually to my understanding LWS only request/grant access to a URL's container document or data-resource. Granting to all container members is not possible.”

A comment proposes using `target` with a recursive constraint; it also says inherited access policies were intended and notes that shape/type-targeting drafts existed in closed PRs but were not brought into the spec. Open issue [#303, “ODRL usage with LWS Access Profile” (opened 10 November 2026)](https://github.com/w3c/lws-protocol/issues/303) is now proposing ODRL-aligned `Asset`/`AssetCollection` targets and asks whether `refinement` should be supported. These were proposals, not the pinned contract. Earlier closed issue [#230, “Improving Access Requests and Access Grants” (18 August–23 October 2026)](https://github.com/w3c/lws-protocol/issues/230) asked how resource-type constraints relate to type search and whether requests could target the storage root with a resource-type constraint; no such target rule appears in the pinned text.

### Purpose, duration, extensions

Yes. The profile supports purpose and time constraints. Its examples use `purpose = https://purpose.example/collaboration`; temporal constraints use `dateTime` with `gteq`/`lteq` to define a window. The text says multiple constraints MUST all be satisfied. The model also says:

> “Other properties MAY be present on access requests and access grants.”

Additional type values and additional target matcher types are allowed subject to server support. This is extensibility, not a defined standard vocabulary for arbitrary PDPP extension fields.

### Issuance, enforcement, revocation and listing

An agent creates an access request by POSTing to the Access Request service. A storage controller creates a grant by POSTing to the Access Grant service. The grant is not itself an authorization token:

> “An agent does not present an access grant to a server as an authorization token. Rather, the access grant serves as a record of what was authorized, to whom, and under what constraints.”

The next sentence is the critical design boundary:

> “When an access grant is created or revoked (deleted), it is the responsibility of the server to adjust any underlying access policy to account for the change. The interaction between an access grant endpoint and a particular policy enforcement layer is out of scope for this specification.”

For ordinary protected resource operations, the OAuth profile requires a storage server to validate the presented JWT and reject an operation when “an authorization policy does not allow the requested operation.” The profile does not standardize how an Access Grant maps to that policy, or require the Access Grant service, authorization server and resource server to be one process/entity. [`Authorization.html`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/Authorization.html) says the authorization server may be the storage server or a separate entity and that interaction between them is out of scope.

The Access Grant endpoint defines `GET /` to “Retrieve a list of access grants,” `GET /:id` to retrieve one, and `DELETE /:id` to revoke one. The general endpoint protocol says GET and POST are minimally required and DELETE is RECOMMENDED. Thus there is an API for listing and revoking grants, but the spec does not say in those endpoint bullets “the owner can list all grants”; normal resource authorization governs access to the endpoint/listing. A grant deletion is the defined revocation action. There is no defined cascade/delegation-revocation protocol.

Open issue [#144, “Potential issues of Authorization Request and Grant being source of truth” (opened 27 April 2026)](https://github.com/w3c/lws-protocol/issues/144) captures unresolved concerns about treating grant records as the source of truth, including synchronization across multiple services and policy systems. An implementation comment describes SAI using grants as source of truth with a custom CSS policy engine, while characterizing LWS as defining a request/grant interface and allowing implementations to use other internal mechanisms.

## 2. RFC 9396 Rich Authorization Requests, ZCAP-LD and GNAP

### RFC 9396 / `authorization_details`

The pinned core, authentication suite pages, and issue/PR search contain no `authorization_details` term and no normative or adopted RFC 9396 integration. The term does appear in historical design material:

* The repository’s [`oct-meeting/README.md`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/oct-meeting/README.md) is explicitly an October 2025 F2F “starting point” and says its suggestions “do not represent a consensus position.” It lists RFC 9396 as a relevant OAuth spec and says an example JWT “would contain an `authorization_details` claim, which the LWS specification would refine.” The accompanying `access-token.json` and OAuth metadata are labeled speculative in that README.
* In the [20 October 2025 WG minutes](https://www.w3.org/2025/10/20-lws-minutes.html), the chair sketched `authorization_details_types_supported` and example categories (“locations,” “datatypes,” “purposes”), then said “the names, they're placeholders” and “we didn't clarify the details.” The conversation was a sketch, not a recorded resolution to adopt RFC 9396.
* The [10 October 2025 F2F minutes](https://www.w3.org/2025/10/10-lws-minutes.html) say the target “needs to express more than just resource URIs,” and discuss type/category targets aligned with “Authorization details.” Again, those are design discussion notes. The later pinned profile has resource URI matchers and ODRL constraints instead.

The implemented baseline at the pin is OAuth 2.0 Token Exchange (RFC 8693), JWT access tokens and resource/audience identification. The access grants themselves use an LWS envelope with an ODRL-based Access Profile. No rationale in the records says “RFC 9396 was rejected”; the evidence says it was considered early, left as placeholder material, and did not become part of the pinned protocol. Do not treat the historical examples as a supported RAR contract.

### ZCAP-LD / authorization capabilities

ZCAP appears in three limited ways, none of which defines ZCAP authorization for LWS:

1. In [`lws10-core/index.html`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/index.html), the generic “authentication credential” definition lists “assertions of capability such as ZCAPs” as an example. That is terminology, not a protocol suite.
2. Closed issue [#74, “Does Authorization Server need to get user consent again for resource authorization grant?” (5 February–12 February 2026)](https://github.com/w3c/lws-protocol/issues/74) asks whether a ZCAP-LD could be embedded in an ID-JAG token as a way to carry delegation. No such embedding was adopted in the pinned text.
3. In open issue [#178, “Orthogonality of specifications” (24 June 2026–open)](https://github.com/w3c/lws-protocol/issues/178), an editor says extracting OAuth into a separate profile “points the way to other Authorization mechanisms (e.g., ZCAP-based Auth).” It is a possible future mechanism, not an implemented requirement.

The [27 October 2026 TPAC minutes](https://www.w3.org/2026/10/27-lws-minutes) show ZCAP, OAuth delegation and ODRL discussed as design options/questions. Participants explicitly ask whether delegation belongs outside the spec or in LWS; the minutes record no adoption decision. The active suite list at the cutoff contains no ZCAP suite.

### GNAP

GNAP is mentioned as prior art, not a dependency. Closed prior-art issue [#18 (opened 13 June 2025; closed 26 January 2026)](https://github.com/w3c/lws-protocol/issues/18) discusses OAuth, UMA, GNAP, policy engines and ODRL while arguing that authorization-server internals should remain orthogonal. Open issue #178 mentions a GNAP or Macaroon token issuer as an example of an alternative authorization server.

The clearest decision rationale is in the discussion on [PR #227, “Add `subject_identifier_types_supported` property to AS Metadata” (merged 21 September 2026)](https://github.com/w3c/lws-protocol/pull/227). In response to a question about GNAP metadata, an editor wrote:

> “At present, the LWS specification requires an OAuth2-conforming authorization server that supports RFC 8693. I think it would be a mistake to require that AS to support features from GNAP or OpenID Connect, both of which go beyond the basic requirements of an OAuth2 authorization server.”

The issue [#296, “Is the ‘Protected Resource Metadata’ too granular?” (opened 2 November 2026)](https://github.com/w3c/lws-protocol/issues/296) also says LWS “doesn't depend on” GNAP or UMA; it switched from an `as_uri` challenge extension to RFC 9728 Protected Resource Metadata. This indicates deliberate reliance on a small OAuth baseline rather than GNAP-specific requirements.

## 3. JSON/NDJSON and non-RDF resources

### Storage and metadata model

The core defines a Storage Resource as an HTTP resource and says RFC 9110 “does not limit the nature of a resource.” A non-container resource is read as content, with the response `Content-Type` matching the stored media type. The `read-resource.md` example says the returned content is “exactly the stored data in the file.” Accordingly, an `application/json` or NDJSON object can be stored as a `DataResource`; its body is not automatically a container listing or a JSON-LD graph just because the protocol uses JSON-LD for its own metadata formats.

`application/lws+json` is used for LWS control/metadata representations, including containers and the Access Request/Grant serialization; raw data-resource bodies use their own media types. This distinction matters: the JSON-LD context applies to LWS control/metadata representations, not to every arbitrary JSON or NDJSON payload.

There is an active caveat for `application/ld+json` and other media types with multiple possible interpretations. Open issue [#110, “Need for a deterministic mechanism to declare the Abstract State Infoset Type of a resource” (opened 27 March 2026)](https://github.com/w3c/lws-protocol/issues/110) argues that an `application/ld+json` body might be treated as raw bytes, a JSON tree or RDF and requests a machine-readable declaration. It remains open. The discussion includes an editor’s view that LWS can treat data resources as files with bytes and media type, but that is not an adopted AIST mechanism. For PDPP’s plain JSON/NDJSON, use an ordinary data media type and treat LWS as file/resource storage; do not assume server-side field/record parsing.

### Linksets, `type`, and `describedby`

Every resource has a separately discoverable linkset (`rel="linkset"`, `application/linkset+json` in the pinned core). Linksets hold HTTP links as metadata. The core’s metadata model requires the linkset and server-managed `up`/type information; client-provided links may be included on creation and metadata can be updated through the linkset endpoint. This allows a client to attach a `rel="type"` link for an application-defined type URI and a `rel="describedby"` link to a schema/document. The link states a relationship; it does not require the server to validate the body against that schema.

In the pinned read example, a JSON file appears in a container listing with `format: "application/json"` and both `DataResource` and a custom type URI. The spec’s own Link example shows `rel="type"` headers. Descriptive metadata properties beyond links remain under-specified: issue [#295, “draft a spec sketch with the mechanics of the metadata aux resource” (opened 29 October 2026)](https://github.com/w3c/lws-protocol/issues/295) is open; the 27 October WG minutes say arbitrary metadata is possible but “not detailed enough.”

### Type index/catalog

The core itself does not require a type index or catalog. A separate Editor’s Draft in [`lws10-index/index.html`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-index/index.html), titled “LWS Search and Type Index Services,” proposes optional `TypeIndexService` and `TypeSearchService` endpoints. It says the core otherwise requires traversing containment “one resource at a time”; a type search returns URIs for resources matching a type filter. It derives searchable types from resource types. This is an “unofficial proposal” in the pinned file and is a tentative deliverable in the proposed charter, not part of the normative core.

So an app could label its NDJSON resource with a stable type URI such as an application-defined listening-history type and, where implemented, discover it through Type Search. There is no core guarantee that every server indexes such links, that it supports the type service, or that the service understands an app’s internal NDJSON records. The optional index locates resource URIs, not records within a file.

Relevant history: closed issue [#104, “LWS Type Index Feature” (17 March–30 March 2026)](https://github.com/w3c/lws-protocol/issues/104) tracks initial feature work; open PR [#260 (opened 4 October 2026)](https://github.com/w3c/lws-protocol/pull/260) adds index service type terms to the context. Open issue [#294, “take on integrating schemata into the LWS protocol” (opened 29 October 2026)](https://github.com/w3c/lws-protocol/issues/294) has no proposal or comments beyond assignment text at the cutoff.

### JSON-specific discussions searched

There is no `authorization_details`-style JSON payload scope and no standard JSON/NDJSON record access mechanism. Relevant JSON discussions were:

* [#246, “Remove requirement that `application/ld+json` and `application/json` must be framed” (14 September–16 October 2026)](https://github.com/w3c/lws-protocol/issues/246), resolved by PR #253: JSON-LD/JSON responses need not be framed as LWS container JSON; clients that require that shape request the LWS media type/profile.
* [#254, “Reconsider supported media types for JSON updates” (25 September–5 October 2026)](https://github.com/w3c/lws-protocol/issues/254), covering JSON Patch versus Merge Patch for metadata linksets. It is not a record-level authorization feature.
* [#110](https://github.com/w3c/lws-protocol/issues/110), above, on ambiguity in interpreting JSON-LD resource bodies.
* Open PRs #306 and #307, §7 below, propose renaming the core’s metadata/container media types. These are active changes to representation conventions, not a JSON-data query API.

## 4. Authentication suites and token refresh

### Suites at the pin

The active W3C publications page at the cutoff lists three current authentication suite Working Drafts:

| Suite | State at cutoff | Notes |
|---|---|---|
| OpenID Connect | Working Draft; publication dated 15 October 2026 | Browser/OP-based identity suite. |
| SAML 2.0 | Working Draft; publication dated 9 November 2026 | SAML identity suite. |
| Self-signed Identity using Controlled Identifiers (SSI-CID) | Working Draft; publication dated 15 October 2026 | Self-issued signed JWT, with a URI subject and controlled identifier document used for verification when there is no pre-existing trust. |

The SSI-CID suite is not the discontinued suite. It generalizes identity verification through W3C Controlled Identifiers. Its explanatory text says it works with HTTPS identifiers and DID URIs; the authorization metadata example includes `did:key` among possible identifier types. Therefore a self-signed `did:key` client may fit under SSI-CID even though the separate `did:key` suite was retired.

### Separate `did:key` suite discontinuation

The separate “Self-signed Identity using did:key” suite was discontinued by [PR #229, “Discontinue authn-ssi-did-key,” merged 18 September 2026](https://github.com/w3c/lws-protocol/pull/229). It removed the README link and automatic publication workflow but retained a discontinued snapshot. The retained page says:

> “This draft is discontinued in favor of LWS 1.0 Authentication Suite: Self-signed Identity using Controlled Identifiers, which subsumes this specification by specifying a generalization of the mechanism described here.”

The rationale was that `did:key` is a DID/CID instance and the general SSI-CID suite could validate it, so the separate suite duplicated a narrower mechanism. Issue [#141, “Does LWS10-AUTHN-SSI-CID already include LWS10-AUTHN-SSI-DID-KEY?” (23 April–2 October 2026)](https://github.com/w3c/lws-protocol/issues/141) records the discussion. An editor said SSI-CID met the server-to-server use case, did:key was redundant, and `did:key` was defined by a Community Group report while CID had W3C TR standing. Consensus to merge the suites was noted 31 July. Earlier PR #226 (opened 11 August, closed without merge 18 August) proposed deleting the suite outright; #229 superseded it and preserved the historical discontinued document. The W3C publication page now lists did:key under “Retired specifications.”

### Authentication and refresh behavior

The generic core requires signed authentication credentials. SSI-CID credentials are JWTs with `sub`, `iss`, `client_id`, `aud`, `iat`, and `exp`; the client can create a fresh signed subject token. The authorization server MUST support RFC 8693 Token Exchange and issues an OAuth JWT access token. Storage servers validate the JWT signature, issuer, storage audience and time claims.

There is no LWS-defined refresh-token flow, refresh endpoint, or requirement for `refresh_token` grant support. The authorization metadata example lists only RFC 8693 Token Exchange as a grant type. A client can obtain a new access token through another exchange using a valid subject token; this is not specified as refresh-token rotation. OAuth servers may have additional behavior, but the LWS profile does not define it.

## 5. Missing primitives and normative levels

| Primitive | Pinned requirement/status | Evidence and open discussion |
|---|---|---|
| Batch writes | No batch/multi-resource write operation is defined. POST creates one resource under one container. | [`Operations/create-resource.md`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/Operations/create-resource.md) specifies one POST target; it says “POST is not idempotent. Repeating it may create duplicates.” Open issue [#173 “Idempotent Create” (12 June 2026–open)](https://github.com/w3c/lws-protocol/issues/173) seeks retry-safe creation, not batch writes. |
| Append | No append operation/semantics. PUT replaces; PATCH modifies according to a patch format. | `update-resource.md`; no issue found asking for append. |
| Transactions | No multi-operation transaction or transaction identifier is defined. The spec does require atomicity within certain single operations (such as resource plus metadata and container membership updates). | Atomicity statements concern one operation, not a transaction spanning resources/requests. Searches of protocol issue titles/bodies/comments for “transaction” found no issue. |
| Conditional reads / `If-None-Match` | Servers MUST return ETags on resource GET/HEAD. Servers SHOULD support RFC 9110 conditional requests, including entity tags and date validators. No LWS rule says clients MUST use `If-None-Match`; it is standard HTTP behavior if supported. | [`Operations/read-resource.md`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/Operations/read-resource.md). |
| Conditional writes / `If-Match` | Clients SHOULD use conditional requests for PUT/PATCH. For linkset updates clients and servers SHOULD use them. On a failed supplied precondition, server MUST return 412. DELETE clients MAY include `If-Match`. Moving-resource clients SHOULD include current linkset ETag; server MAY require conditionals and reject unconditional requests with 428. | [`update-resource.md`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/Operations/update-resource.md), [`moving-resources.md`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/Operations/moving-resources.md). |
| Strong/weak ETags | LWS does not explicitly require strong or weak tags. HTTP semantics still apply: `If-Match` uses strong comparison, so a weak ETag cannot satisfy it. The spec’s examples use quoted strong-looking tags, but examples do not impose the tag strength. | Open issue [#245 “Implementors guidance on ETags” (14 September 2026–open)](https://github.com/w3c/lws-protocol/issues/245) has discussion of per-representation validators and strong/weak tags. Open issue [#240 “clarify ETag requirements for Containers (recursively)” (31 August 2026–open)](https://github.com/w3c/lws-protocol/issues/240) discusses updating parent-container validators when descendants change. |
| Change notifications | Core notifications are OPTIONAL. When present, the core data model defines Create/Update/Delete and, for servers supporting moves, Move activities. A server MAY batch several activities into one notification. | [`Notifications.html`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/lws10-core/Notifications.html). |
| Replayable change feed | No durable cursor, event-history query, replay window, or resume token is defined in the pinned core or webhook suite. | The separate webhook Editor’s Draft says delivery failure “MAY” be retried and repeated failures “MAY” deactivate a subscription. That is retry, not history/replay. Open PR [#284 “LWS 1.0 Notification Suite: HTTP Streaming” (opened 24 October 2026)](https://github.com/w3c/lws-protocol/pull/284) is an early draft; it proposes JSON Sequence and notes more feedback remains. No issue explicitly requesting a replayable feed surfaced in issue searches for “change feed” or “replay.” |

The main synchronization caveat is not only missing replay. Issue #240 asks whether recursive container ETags should change when descendants change. A TwinPod implementation comment says it updates ancestor ETags; a remoteStorage implementer says a tag need only signal “something” changed. The question remains open, so clients cannot assume a uniform recursive validator strategy.

## 6. Implementations, test assets, WG timeline and status

### Implementations referenced by the source set

The pinned [`Implementations.md`](https://github.com/w3c/lws-protocol/blob/db64f561e417339e06a6c4bf513270bae0f5a7f2/Implementations.md) is the WG’s implementation tracker. It distinguishes “Interested,” “Committed,” “Implementing” and “Conforming.” For core server features and Authentication/Authorization, listed implementations are mostly marked **Implementing** (not conforming):

* **lws-server** — Java server, [ebremer/lws-server](https://github.com/ebremer/lws-server); the tracker links a branch and [conformance page](https://ebremer.com/lws/conformance).
* **Halcyon** — Java/JavaScript server, [halcyon-project/Halcyon](https://github.com/halcyon-project/Halcyon); tracker links a `next` branch and the same conformance page.
* **sparq** — Rust/Python/TypeScript server, [sparq.jeswr.org](https://sparq.jeswr.org/).
* **Community Solid Server** — TypeScript server, [CommunitySolidServer](https://github.com/CommunitySolidServer/CommunitySolidServer); tracker links an LWS feature branch.
* **sai-js** — TypeScript client and partially applicable server; the tracker notes its server is implemented as custom components for Community Solid Server. Its access-grant section is marked implementing; its ODRL profile support is only interested.

Other LWS-related code entries are **lws-authn** (Java authentication server/implementation, not the storage server) and **lws-client** (client only). The repo’s [issue #73](https://github.com/w3c/lws-protocol/issues/73), closed 2 March 2026, has a commenter mentioning **TwinPod** triple-level authorization and a separate implementation discussion. Issue #240 has a TwinPod implementer’s ETag comments. These are implementation anecdotes, not entries marked conforming in the tracker. Issue #73’s final design discussion emphasizes the performance cost of per-member filtering; the current core permits container listings to be filtered based on authorization.

The W3C group’s linked repo inventory (via `gh repo list w3c`) surfaced the protocol, use-case repo [`w3c/lws-ucs`](https://github.com/w3c/lws-ucs), and charter repo [`w3c/lws-wg-charter`](https://github.com/w3c/lws-wg-charter). The separate test suite is [`lws-contrib/lws-test-suite`](https://github.com/lws-contrib/lws-test-suite), linked from the protocol’s implementation tracker. I found no additional LWS storage server listed in the charter/use-case repo or the protocol’s tracker. The 27 October 2026 WG minutes mention SAI and Inrupt as prior art for sharing/notification services, not as additional conforming LWS server entries.

### Test suite and implementation report

The test repository README describes its `lws10/` directory as the “1.0 core test suite.” Its manifest currently contains core behavior cases (resource/container GET/HEAD/POST/DELETE, ranges, media types, ETags, storage description). It also contains a deliberately failing fixture named `deleteReturns999IntentionallyFailing`; this is a test-suite authoring artifact, not a reported implementation failure. The repo does not present a consolidated pass/fail report for implementations.

Open issue [#286 “Implementation Report with passing/failing tests” (opened 27 October 2026)](https://github.com/w3c/lws-protocol/issues/286) proposes a web presence for such a report. As of the cutoff it remains open. The 2024 charter says the WG “will develop a test suite and implementation report”; the current tracker still shows implementing states and links to individual conformance pages rather than a public, consolidated report. Thus there is an evolving core suite and partial implementation tracking, but the evidence reviewed does not establish two independently interoperable conforming servers for every feature.

### Timeline and current standards status

The original [2024 WG charter](https://www.w3.org/2024/09/linked-web-storage-wg-charter.html) scheduled core FPWD for **11 March 2025**, CR for **10 March 2026**, Proposed Recommendation for 9 June 2026 and Recommendation for 8 September 2026. W3C activity history records actual **First Public Working Draft on 31 March 2026**. The initial CR target was missed.

At the cutoff, the LWS Core was still a **Working Draft**; W3C lists the latest publication on **9 November 2026**. OpenID Connect and SSI-CID were also WDs (15 October); SAML was a WD (9 November). No core CR had been published. The Working Group page said the old charter had been extended through 8 January 2027. A proposed November 2026 charter, under vote through 9 December 2026, forecasts **CR in Q2 2027** for core and authentication suites, and Recommendation in Q2 2028. That is a proposal, not an approved charter at this cutoff. It explicitly lists Type Index as a tentative deliverable with expected completion Q4 2028; webhook notifications are also listed as tentative, with Q2 2028 expected completion.

Primary timeline/status pages: [WG charter (original)](https://www.w3.org/2024/09/linked-web-storage-wg-charter.html), [proposed charter (November 2026)](https://www.w3.org/2026/11/lws-wg-proposed-charter.html), [WG publications](https://www.w3.org/groups/wg/lws/publications/), and [WG activity](https://www.w3.org/groups/wg/lws/activity/2026/). The 27 October 2026 TPAC minutes say the original charter ran September 2024–September 2026, the group was under extension/rechartering, and the aim was to enter CR “in about 6 months.”

## 7. Main changes after 9 November 2026 and open PRs

At the research cutoff, `main` still pointed to the pinned `db64f561` commit dated 9 November 2026. GitHub compare reported zero commits ahead (`main` == pin); therefore **there are no commits on main after the pin**. The following open PRs touch the requested subject areas (dates are PR creation dates; none was merged into the pinned main):

| PR | Date | Scope/relevance |
|---|---|---|
| [#305 “Access tokens at same-origin storage services”](https://github.com/w3c/lws-protocol/pull/305) | 11 Nov 2026 | Changes Authorization, Discovery, Notifications and Access Requests/Grants. Its description says services such as notifications/access requests may use a storage’s own token when on the same server; services belong to exactly one storage and clients may send the token anywhere on that server, nowhere else. Directly material to separate PDPP/service topology. Resolves open issue [#304](https://github.com/w3c/lws-protocol/issues/304), which says the current text did not specify which storage’s token services use or what a 401 points to. |
| [#299 “Extract an LWS OAuth profile from the core specification”](https://github.com/w3c/lws-protocol/pull/299) | 5 Nov 2026 | Moves OAuth Authorization/Authentication material into a separate required `lws10-oauth` document; edits OpenID, SAML and SSI-CID suite docs and core resource operation references. Directly changes where authorization requirements live. |
| [#301 “Use invalid_token in the token validation example”](https://github.com/w3c/lws-protocol/pull/301) | 7 Nov 2026 | Small Authorization example/error change. |
| [#307 “Change application/lws+json to application/ld+json with a profile”](https://github.com/w3c/lws-protocol/pull/307) | 13 Nov 2026 | Touches container representation, media-type rules, Access Requests/Grants, notifications, index services. Would change LWS’s own JSON-LD representation conventions; not a change to arbitrary data-resource JSON. |
| [#306 “Change usage of application/lws+cid to application/cid”](https://github.com/w3c/lws-protocol/pull/306) | 13 Nov 2026 | Changes storage-description media type and IANA/media-type text. Relevant to discovery metadata, not payload field access. |
| [#277 “Describe media type and size per representation in container listings”](https://github.com/w3c/lws-protocol/pull/277) | 19 Oct 2026 | Changes read/container metadata and media-type text, including per-representation media type/size. Relevant to discovering JSON/NDJSON resource files. |
| [#260 “add index services types to JSON-LD context”](https://github.com/w3c/lws-protocol/pull/260) | 4 Oct 2026 | Adds Type Index/Search service vocabulary terms; relevant to the optional data catalog. |
| [#113 “Support for auxiliary resources and manifest”](https://github.com/w3c/lws-protocol/pull/113) | 30 Mar 2026 | Still open; changes auxiliary metadata/manifest and resource operation behavior. Adjacent to metadata/schema discovery. |

Relevant open issues (not PRs): [#303 ODRL Access Profile realignment](https://github.com/w3c/lws-protocol/issues/303) (10 Nov), [#304 service-token ambiguity](https://github.com/w3c/lws-protocol/issues/304) (11 Nov), [#294 schema integration](https://github.com/w3c/lws-protocol/issues/294) (29 Oct), and [#280 container-member grants](https://github.com/w3c/lws-protocol/issues/280) (21 Oct).

## Six-line design risk summary

1. LWS grants select resource URIs/types and standard whole-resource constraints; there is no interoperable query, JSON field, or NDJSON-record scope.
2. Container-member grants are explicitly unresolved ([#280](https://github.com/w3c/lws-protocol/issues/280)); a container URL does not currently mean its changing membership set.
3. A grant is a record; the spec leaves its mapping to the live policy-enforcement layer out of scope, so PDPP must own and prove that enforcement boundary.
4. JSON/NDJSON bodies are opaque data resources; linksets can label/link a resource, but no core schema validation, row discovery, or content catalog is required.
5. RFC 9396 was an early placeholder, not the pinned contract; LWS requires OAuth Token Exchange and has no defined access-token refresh flow.
6. The core is still a WD, tests/reporting are incomplete, and open PRs #305/#299/#306/#307 plus issues #303/#304 can change authorization and metadata behavior.
