# Search

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 2. Search

**Who starts:** The person. **Where:** `/explore` (`Records feed`), `/search` (`Jump to artifact`), or the topbar `Jump to…` palette. **Code:** Explore page above; `/search` `apps/console/src/app/(console)/search/page.tsx:16-120`; `apps/console/src/app/(console)/explore/explore-canvas.tsx:1`; `reference-implementation/vendor/operator-ui/src/components/command-palette.tsx:64-105,113-233`; `reference-implementation/vendor/operator-ui/src/components/command-registry.ts:70-195` (V).

1. In Explore, the search field accepts free text and structured tokens. The parser supports source/connection and stream include/exclude, `has:image`, `has:link`, and date terms such as `before:2026-06-11`; the page also provides source/stream facets and since/until dates. Search uses hybrid or lexical record search; default empty query loads recent records and does not invoke content search. **V** `apps/console/src/app/(console)/explore/page.tsx:5-16,66-103`; `apps/console/src/app/(console)/explore/explore-grammar.ts:1`; `apps/console/src/app/(console)/explore/explore-query-input.ts:1`; `reference-implementation/vendor/operator-ui/src/explore/explore-data-assembler.ts:1`.
2. Search results are record rows in Explore, with snippets for keyword results. Search hits without a full record body use a generic kind because the UI cannot safely infer a richer card from a snippet. Results can be sorted by relevance or recency when the set supports it; full chronological mode can be sorted newest/oldest. Some semantic result sets are bounded, and the UI identifies them as “Top matches” rather than claiming exhaustive results. **V** `reference-implementation/vendor/display/src/record/record-kind.ts:16-24`; `reference-implementation/vendor/operator-ui/src/explore/set-descriptor.ts:110-174,201-220`; `apps/console/src/app/(console)/explore/explore-canvas.tsx:1`.
3. Explore displays a result count only when the backend’s count descriptor supports it. Search has a set label such as “Keyword matches” or “Keyword matches, newest first”; exact filters can say “Your filtered set: N records.” Bounded relevance results do not claim a corpus total. No results in Explore: “No records matched the active filters” when rows were loaded before filtering; otherwise “No records in this view.” **V** `reference-implementation/vendor/operator-ui/src/explore/set-descriptor.ts:110-120`; `apps/console/src/app/(console)/explore/explore-canvas.tsx:1070,2422`.
4. `/search` is an ID jump, not a second content-search implementation. Its page says “Paste a trace, grant, or run id to jump directly to it. For record content search, use Explore.” The field label is `Artifact id`, placeholder `trace id, grant id, or run id…`, button `Go`. An exact trace/grant/run match redirects directly to the detail page. Other text redirects to Explore with `q=…`. `jump=0` stops auto-navigation and shows only trace, grant and run results. Exact matches link to `/grants/<id>`, `/syncs/<id>`, or `/audit/<id>`. With an empty query it says “Paste a trace, grant, or run id. Search records by text in Explore →”. A non-empty query with zero matches shows `0 artifacts` and no separate no-match sentence. **V** `apps/console/src/app/(console)/search/page.tsx:23-55,74-120`; `reference-implementation/vendor/operator-ui/src/components/views/search-view.tsx:45-83,85-173`.
5. The palette opens with click `Jump to…` or `⌘K`/`Ctrl+K`. It shows “Search commands, or type to search records…” and help “↑↓ move · ⏎ open · ⎋ close · ⌘/ctrl+k toggle”. Typing filters registered navigation/quick-action commands; a separate last row offers the typed record search. With no matching command it says “No matching commands.” Escape closes; arrows move; Enter activates the selected row. **V** command palette `:64-105,113-183,189-259`.

**Setup / failures:** The deployment should have a working resource server. Before lexical search works, the server must have its search index; semantic/hybrid search also depends on server-side model/index readiness. Deployment readiness exposes index/model setup and download policy; the dashboard does not present an end-user “build search index” wizard here. If server is unreachable, it displays “Reference server unreachable”. **V** `apps/console/src/app/(console)/explore/page.tsx:164-172`; `apps/console/src/app/(console)/deployment/page.tsx:1`; readiness rows `apps/console/src/app/(console)/components/deployment-readiness-rows.ts:1`.

**Rough edges:** Search and ID jump are separate pages but both sit under Explore navigation. Some Explore scopes are bounded and intentionally do not claim total recall. The selected connection chip can post-filter connector-type search hits because the backend search API does not yet narrow by connection ID; the code labels that behavior instead of claiming a connection-level server filter. **V** `apps/console/src/app/(console)/explore/page.tsx:18-32`.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `search`. **Combined isolated run:** `search`: **pass**.

**What it verifies:** The capture reaches the search entry page at both viewports.

**Reaches:** The `/search` route renders with “Jump to artifact”.

**Stops at:** It does not submit a populated query or assert a search result.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: search"
```

**Evidence:** `evidence/search/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The route screenshot does not prove search indexing or result accuracy.
