# Browse collected data and inspect records

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 1. Browse collected data and inspect records

**Who starts:** The person. **Where:** `/explore` from the sidebar’s `Explore` entry, then `Records feed`; or `/sources` from `Sources`. The source list and source detail also link to records and streams. **Form:** Console, including the desktop-bundled console. **Terminal/account:** No. **Code:** `apps/console/src/app/(console)/explore/page.tsx:66-174` (V); `apps/console/src/app/(console)/explore/explore-canvas.tsx:1` (V); `apps/console/src/app/(console)/sources/page.tsx:1`, `apps/console/src/app/(console)/sources/[connector]/page.tsx:1`, `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:1`, `apps/console/src/app/(console)/sources/[connector]/[stream]/[recordKey]/page.tsx:1` (V); `apps/console/src/app/(console)/components/record-inspector.tsx:103-255` (V); presentation in `reference-implementation/vendor/display/src/record/record-kind.ts:37-55,207-247` and `reference-implementation/vendor/display/src/record/record-preview.ts:269-461` (V).

1. In **Explore**, the person sees a combined chronological feed. It can show records from multiple connected accounts. The source/stream facet rail narrows the feed. URL query parameters preserve the query, source/connection, stream, date, sort direction, selected peek, and saved-view state. The page can show recent, upcoming, keyword-search, or time-range views. **V** `apps/console/src/app/(console)/explore/page.tsx:66-103,128-161`; canvas controls and URL wiring in `apps/console/src/app/(console)/explore/explore-canvas.tsx:1` and `apps/console/src/app/(console)/explore/explore-navigation.ts:1`.
2. A record row leads with a presentation preview only when declared metadata supports it. The supported preview kinds are `message`, `money`, `event`, `activity`, `reader`, `location`, `titled`, and `generic`; their small labels include `message`, `money`, `event`, `activity`, `read`, `place`, `item`, and `record`. A message can show declared author/title/body; money can show a declared amount; event can show declared title/time; titled items show declared title/author/body. **V** `reference-implementation/vendor/display/src/record/record-kind.ts:37-55,147-246`; `reference-implementation/vendor/display/src/record/record-preview.ts:234-316`.
3. There is no special display selected just because a stream is named `emails`, `purchases`, `transactions`, `files`, or `attachments`. Kind inference from stream and field names was removed. If roles/types are not declared, the feed card uses a neutral `record` identity and a humanized key/value preview; undeclared fields are not guessed into a title. The generic record detail is a readable field/value display, with a separate `Raw JSON` disclosure. **V** `reference-implementation/vendor/display/src/record/record-kind.ts:57-63,207-247`; `reference-implementation/vendor/display/src/record/record-preview.ts:318-405,433-460`; `apps/console/src/app/(console)/components/record-inspector.tsx:168-184`.
4. Selecting a row opens the Explore reading-room inspector. Before selection it says: “Select any row to inspect the full record, links, files, and sharing facts.” The placeholder explains “Fields” as “label + the wire key a client receives”, “The call” as “the exact request that reads this record”, and “Withheld” as “what stays with you, never shared.” A selected record shows stream, record ID, full owner view, visible fields, withheld fields (if relevant), raw JSON, record size, relationship links, and `Record request: GET …`. **V** `apps/console/src/app/(console)/components/record-inspector.tsx:103-125,151-255`.
5. A declared blob field with a server-provided usable `fetch_url` can render an image preview for image MIME types and an `Open blob →` link, sometimes with a size. If the blob is not available, the inspector displays the server reason or “Blob unavailable for this view.” There is no universal attachment gallery. **V** `apps/console/src/app/(console)/components/record-inspector.tsx:73-100`; blob affordance built by `reference-implementation/vendor/operator-ui/src/components/views/explorer-utils.ts:1` (V).
6. The person can follow declared parent/child relationship links, return to `Open all records in this stream →`, and use breadcrumbs to go to Sources, source, and stream. On the full record route, the page title is a declared preview identity when available; otherwise it is a neutral field or record-key identity. **V** `apps/console/src/app/(console)/components/record-inspector.tsx:199-243`; record route `apps/console/src/app/(console)/sources/[connector]/[stream]/[recordKey]/page.tsx:187-270`.
7. The stream page shows a paged table (50 records per page), manifest-derived/default columns, selectable columns, field filters, ascending/descending ordering, and a count/status line such as “page N · X shown of Y total” when the backend can give a total. For filtered data it can say “matching records” and “total held”. **V** `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:67-121` plus table rendering further below in that file.

**Branches/failures:** Unavailable resource server displays “Reference server unreachable” and deployment guidance. Missing source/record resolves to not-found. Explore can show failed peek/read state in the inspector; unavailable declared stream metadata removes typed affordances. A blob can be unavailable. **V** `apps/console/src/app/(console)/explore/page.tsx:164-172`; record route `apps/console/src/app/(console)/sources/[connector]/[stream]/[recordKey]/page.tsx:187-270`; stream route `apps/console/src/app/(console)/sources/[connector]/[stream]/page.tsx:73-121`; `apps/console/src/app/(console)/components/record-inspector.tsx:73-81`.

**Afterwards:** The selected record remains addressable by `/sources/<connector>/<stream>/<recordKey>`; stream and source links remain available. No individual record-delete, record-export, or “download all collected data” control was found. Blob opening is the record-level download/open affordance. Deleting a source/connection is a separate source-management action and can delete its collected records; see `apps/console/src/app/(console)/sources/[connector]/actions.ts:1` and `apps/console/src/app/(console)/lib/delete-connection-with-run-cancel.ts:1`. **V** for absence in the inspected routes/components; deletion effect V in those files.

**Rough edges:** The `/sources/<connector>/<stream>/<recordKey>` detail route is a second way to read an item, while Explore has a side inspector. No app-specific email/purchase/transaction/file card is guaranteed. The list route may show field columns while Explore uses the preview and inspector. Blob availability is conditional on declared manifest metadata and a fetched URL. There is no item-level delete or bulk-export control. **V** cited files above.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `explore-data`. **Combined isolated run:** `explore-data`: **pass**.

**What it verifies:** The fixture emits Spotify records through the real seed connector and the page renders them.

**Reaches:** The Explore page renders and contains the seeded “Radiohead” record.

**Stops at:** This journey does not open a record inspector or prove search filters, field projection, or every stream.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: explore-data"
```

**Evidence:** `evidence/explore-data/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The data are fictional seed records. The capture verifies a populated Explore view, not a live provider account.
