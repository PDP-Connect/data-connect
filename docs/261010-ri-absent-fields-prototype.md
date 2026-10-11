# Absent fields, partial updates and duplicate keys: RI prototype

Prototype of [PDPP draft #398](https://github.com/PDP-Connect/pdpp/pull/398). Not for merge until the specification is final. Baseline: `4e69b5dff8a52e3547444a6ac57d7d12dd6940b8`.

Behavior changes require `PDPP_EXPERIMENTAL_RECORD_UPDATES=1`; the default is off. The experimental profile instruction is `{type:"PDPP_EXPERIMENTAL_PARTIAL_UPDATE_V1", key, set:{...}, remove:[...]}`. The ingest route supplies the stream. Direct storage calls also supply `stream`. `set` replaces named top-level values; `remove` deletes named top-level fields. It cannot include snapshot `data` or `op`. Core defines no such syntax.

## Requirement evidence

The named subtests below run on both SQLite and actual PostgreSQL in `reference-implementation/test/experimental-record-updates.test.ts`. **Held** means the tested scenario satisfies the draft. **Wrong** means the tested RI behavior contradicts the draft, not that the draft must change. **Underspecified** identifies a choice or precision bound the draft does not fix. These are bounded prototype findings, not a Core conformance certificate.

| Requirement | Verdict | Test evidence and result |
| --- | --- | --- |
| Omitted top-level field inside the effective projection has no stored value in that version | Held | `partial set/null/remove preserve unnamed values and projected reads`: removed optional field is absent, not null. |
| Omission outside the projection makes no assertion | Held | Same subtest: a client grant with frozen fields omits the stored required value. HTTP tests exercise owner `fields` and resolved `view` projections. |
| Null is distinct from absence and allowed only by the schema | Held | Same subtest preserves explicit nullable null; `required fields, nullability, identity and malformed instructions roll back atomically` rejects nonnullable null. |
| Required fields and record identity remain mandatory | Held | Atomic rollback subtest rejects required/identity removal and identity mutation. `removing required constructor cannot be satisfied by inherited properties and is atomic` verifies own-property validation. |
| Returned snapshots replace a client's copy within the same projection | Held for the wire representation | `snapshot replacement and complete version history`: an omitted formerly present field disappears; a test-side replacement copy also loses it. There is no production client cache in this RI test. |
| Partial updates are distinct, name set/remove fields and preserve unnamed fields | Held | `partial set/null/remove preserve unnamed values and projected reads` and `concurrent instructions preserve both writers and array order is significant`. |
| Applying an instruction is atomic and yields a complete schema/identity-valid snapshot | Held | Atomic rollback and concurrency subtests compare current records, history and version counters; schema-ID, inherited-property and `overflowing JSON numbers cannot become stored null and reject atomically` regressions are covered. |
| Reads, time constraints, history and incremental results consume complete snapshots | Held | `time constraints and changes_since use complete resulting snapshots` and `snapshot replacement and complete version history`; instructions are never served as records. |
| A partial instruction cannot modify an existing append-only record | Held | `JSON equality and append_only schema/identity validation before duplicate conflict` rejects it before storage. |
| Core specifies no partial-update syntax | Underspecified by design | `flag off retains RECORD legacy rewrites and rejects prototype instructions` verifies the boundary; marker, no-op instructions, missing-record rejection and overlapping set/remove rejection are profile choices. |
| A duplicate is scoped to source, stream, instance and canonical key; identity validation runs first | Held | JSON equality/identity subtest rejects mismatched and incomplete identities; `instance scoping, delete and post-delete reinsert` permits another instance. |
| Equal append-only retry leaves data, emitted_at, version, history and notifications unchanged | Held | JSON equality subtest compares all storage rows/counters and hook calls; `beginning and retries; pruned append_only history anchor stays unchanged` covers the existing self-heal path. |
| JSON-value equality ignores object order and whitespace; arrays retain order | Held | JSON equality subtest uses nested reordering and rejects reordered arrays. |
| Numbers compare by numeric value regardless of spelling | Underspecified precision | JSON equality subtest covers `2.0`/`1e0`. `observed precision limit: distinct unsafe JSON integers collapse before append_only equality` shows that exact numeric comparison beyond JavaScript binary64 precision is not established. |
| Different append-only data reports a producer conflict and should be visible to the owner | Held for the ingest interface | `<backend>: HTTP prototype conflicts and malformed instructions have permanent replayable receipts` in `experimental-record-updates-http.test.ts`: permanent conflict code, stable receipts and unchanged owner read. UI presentation of those receipts is unverified. |
| A duplicate creates no incremental result; the existing record appears from beginning | Held with retained history; wrong after pruning | Beginning/retry subtest returns the original record with no duplicate result. `observed residual: beginning after anchor pruning expires although current append_only record survives` instead returns `cursor_expired` on both backends. |
| Explicit deletion remains allowed and produces tombstones | Held | Instance/delete/reinsert subtest asserts a tombstone with no `data` snapshot, then permits reinsertion. Owner deletion uses the existing delete path; this test drives ingest deletion. |
| Collection freshness does not establish reobservation of every returned field | Held as a counterexample | `new collection freshness does not establish reobservation of preserved unnamed fields`: a later partial collection produces current freshness while an unnamed value survives from an earlier write. Freshness derivation is tested directly, not via a collection scheduler. |

`derived lexical index receives complete snapshots after partial instructions` additionally verifies retained unnamed index fields and deletion of a named indexed field. `schema IDs are scoped to schema contents and do not collide across streams` covers legal schemas with reused `$id` values.

## Backend findings

The baseline SQLite no-op check compares serialized JSON. PostgreSQL compares `jsonb`; reordered object members therefore differ on SQLite but not PostgreSQL. The flag-on prototype uses JSON-value equality for append-only retries on both and for SQLite mutable-state retries. Both reject changed append-only data before allocating a version. Mutable-state instructions apply under the existing writer transaction/lock and are indexed from the resulting complete snapshot with a version guard.

Baseline reproductions failed with a missing append-only rejection and a SQLite reordered-object rewrite. Both pass after the patch. Independent review also reproduced a shared AJV registry collision for reused schema IDs and acceptance of removed required `constructor` through inheritance. The prototype isolates schema registration and requires own properties; both regressions now pass on both backends. Default-off tests also preserve legacy RECORD envelopes with ignored `set`/`remove` extensions and reject the explicit experimental marker.

The retained-history requirement is not a blanket pass. The existing RI repairs missing append-only history anchors by making an equal retry a changed write. That violates #398's no-new-version requirement. This prototype prevents that repair; the current record remains readable, but a new beginning session expires. Resolving the feed behavior requires the later change-feed step; changing the draft is not implied by this finding.

Numeric precision is a second scope limit. `operations/rs-records-ingest/index.ts` parses NDJSON with native `JSON.parse`, so distinct JSON integers `9007199254740992` and `9007199254740993` both become `9007199254740992`. An ordinary `type: "integer"` schema accepts the parsed value; neither backend can recover the original digits after storage serialization. No global safe-integer or I-JSON restriction was found in the installed contract or the local Core draft inspected. The prototype compares parsed JavaScript numeric values, not arbitrary-precision decimals. #398 does not specify a numeric precision bound; the large-integer test records this limit without rewriting the ingest parser.

Overflow is a separate failure from integer precision. Native parsing turns `1e400` into Infinity, which permissive schema validation accepted and serialization replaced with null. Both backends reproduced this nonnullable-field violation. The prototype now rejects non-finite numbers recursively before validation, including nested objects, arrays and fields without a numeric type constraint; snapshot and partial-write rejection leave storage unchanged. This restriction is a prototype representability choice, not a new Core numeric bound.

## Connector scan

Run `node reference-implementation/scripts/scan-append-only-streams.ts <connector-directory>`. The scanner inventories declared streams and marks field-name candidates. Implementation evidence is required to call a candidate a conflict. `append-only-manifest-scan.test.ts` verifies discovery, exclusions and a same-content Apple Photos metadata change using the shipped parser.

| Input | Manifests | Streams | append_only streams |
| --- | ---: | ---: | ---: |
| RI pinned connector source `06ed284e1b7ee92b2ebab6bc8ef25f0ae392f84a` | 52 | 211 | 31 |
| RI shipped polyfill tarball | 45 | 173 | 31 |
| RI seed manifests | 4 | 11 | 3 |
| Newer connector source `302363c0cf52c916d196ee6b1ee979ef67866f3e` | 52 | 212 | 31 |

These inventories overlap; the counts are not additive. Pinned Chase balances include run-time `fetched_at` under the same account/as-of key, and transactions explicitly re-emit changed business data under the same transaction key. Newer Chase source removes that run-time data field; the pinned RI still has it. Apple Photos uses a content-only key but includes filename/mtime/hydration metadata. ChatGPT message IDs also carry mutable conversation-graph fields. The complete pinned table follows below.

## Validation

The combined three-file run passes 41 tests with zero failures or skips, including actual SQLite and PostgreSQL the numeric precision observation and overflow rejection. Typecheck and scoped checks pass for the five new TypeScript files without warnings. The existing PostgreSQL template registry includes both new application-behavior test files; its three inventory checks pass. Repository-wide `check` fails on the untouched baseline as well; shared files are not reformatted wholesale.

The full RI suite completed with the ambient flag off: 1,124 file outputs, 11,259 assertions, 10,865 passed, zero failed and 394 declared skips; runner exit 0. It used `memory-default` with concurrency four. PostgreSQL-dependent tests in this full run are declared skips; the separate 41-test run used the actual PostgreSQL oracle without skips. The overflow guard was added after the prototype files had completed in the full run; the final focused run covers that flag-on-only change and both flag-off storage cases. Final typecheck and scoped formatting checks pass.

Earlier full attempts were interrupted by console setup, a T3 restart and a stalled integration file. The stalled `pdpp.test.ts` passed all 118 tests in isolation on both the current revision and untouched baseline. The final full run also completed that file. Its success does not establish the earlier stall cause. The new test files needed template-registry entries; those two entries are included and all three inventory checks pass.

Live-account connector replay, cross-process concurrent writers, semantic embedding updates and a production client cache are not verified. Independent review also notes that existing SQLite rows are JSON-parsed before the disabled append-only helper returns; default-off performance overhead is unmeasured. PostgreSQL tests use disposable databases and the existing JSONB record oracle; they do not require the optional vector extension.

## Pinned implementation audit

All 31 pinned append-only streams were inspected: 14 have concrete conflicting-emission paths, 11 have possible changes and six have no conflict found. The following paths refer to the pinned connector source named above. No live account replay was performed.

Classification:

- **Confirmed:** implementation contains a concrete changed-data/same-key emission path. This is static code evidence, not an observed account incident.
- **Possible:** source metadata outside the key can change; no concrete occurrence was established.
- **No found:** no conflicting rewrite path found in the inspected implementation; not a guarantee.

| Append-only stream | Classification | Evidence |
|---|---|---|
| `anthropic.messages` | Possible | `connectors/anthropic/parsers.ts:203` uses message UUID; `:211–219` stores content, update time and attachments. `index.ts:1393–1402` emits messages again for in-window conversations. Changed exports can preserve UUID. |
| `apple-health.records` | Possible | `connectors/apple_health/parsers.ts:235` hashes type/source/start/value; `:242–253` adds source version, device, end date and metadata outside that identity. `index.ts:265` emits it, subject to start-date cursor. |
| `apple-health.workouts` | Possible | `connectors/apple_health/parsers.ts:269` hashes activity/source/start; `:276–297` stores duration, totals, events, statistics and metadata outside identity. `index.ts:286` emits it, subject to cursor. |
| `apple-photos.photos` | **Confirmed** | `connectors/apple_photos/parsers.ts:88–105`: ID depends on content hash, while data includes filename, mtime and hydration outcome. `index.ts:218–233` emits each file newer than prior cursor. Identical bytes under another filename or later export mtime produce changed data with the same ID—even within one directory walk. |
| `chase.transactions` | **Confirmed, conditional** | `connectors/chase/index.ts:1795–1825`: ID is account ID + FITID; payload includes `fetched_at` and acquisition `source`. `:3120–3128` fingerprints exclude those fields. Ordinary unchanged repeats are suppressed, **but reset/legacy fingerprint state re-emits changed run metadata**, and real transaction-field changes explicitly trigger same-key emission. Do not report unconditional per-run churn here. |
| `chase.balances` | **Confirmed** | `connectors/chase/index.ts:2471–2477`: ID is account ID + balance `as_of`; every emitted payload includes current run `fetched_at`, with no fingerprint gate. Re-fetching unchanged balance data changes the same-key snapshot. |
| `chatgpt.messages` | **Confirmed** | `connectors/chatgpt/parsers.ts:432–449`: node ID is stable, but data includes `children_ids` and `on_current_branch`. Adding a reply changes the existing parent’s children; branch selection can change membership. `index.ts:2605` re-emits messages from updated conversations. This is stronger evidence than merely assuming message text edits. |
| `claude-code.messages` | No found | `connectors/claude_code/index.ts:326–347` maps source UUID and JSONL event fields directly. No hydration/run-clock fields in the message snapshot. |
| `claude-code.attachments` | **Confirmed** | `connectors/claude_code/index.ts:385–407` attaches capture status/hash to stable UUID. File attachments use stable path-derived key at `:589`; `:601–618` emit capture status/hash and retain failed capture obligations for another attempt. Successful retry changes the same-key snapshot. |
| `codex.messages` | No found | `connectors/codex/index.ts:911–930`: ID is session + line number and data comes from that log entry; append-tail cursor handling starts at `:1454`. No ordinary same-key mutation found. |
| `codex.function_calls` | **Confirmed on full replay** | `connectors/codex/index.ts:952–961` constructs call-ID record with null output; `:1144–1152` flushes unanswered calls. `:980–993` emits populated output under that call ID when call/output are parsed together. A later full replay of a completed log changes the previously incomplete call snapshot. Normal append-only output fallback at `:995` uses a **different** key, so do not claim every incremental completion overwrites it. |
| `github.events` | No found | `connectors/github/parsers.ts:336–350` stores event ID/type/time/repository/public flag. `index.ts:1574–1583` skips events at/before prior cursor. No connector-created changing field found. |
| `gmail.message_bodies` | **Confirmed** | `connectors/gmail/index.ts:977–1025` emits the body record before testing `fetchFailed`, then records a retry gap. `:739–748` explicitly describes failed-fetch empty records and same-message retry. `parsers.ts:810–826` keeps Gmail message ID while body data changes after successful hydration. |
| `gmail.attachments` | **Confirmed** | `connectors/gmail/index.ts:3190–3204` emits existing attachment identity with null blob/hash and failed status; `:3755–3759` supplies hydrated blob/hash/status. Emission/retry paths at `:879–883` and `:2671–2691` retain the same attachment identity. |
| `google-maps.timeline_points` | Possible | `connectors/google_maps/parsers.ts:178–201` hashes source/kind/segment/time/rounded coordinates, but stores accuracy, altitude, speed, activity and full coordinates outside identity. Re-imported corrected metadata can conflict. |
| `google-maps.timeline_segments` | Possible | `connectors/google_maps/parsers.ts:216–244` hashes substantial segment identity but omits probability and semantic type. Corrected exports can retain key while changing those values. |
| `google-messages.messages` | Possible | `connectors/google_messages/index.ts:388–408` keys by provider message ID but includes current `chat_name`, sender and body. `:797–822` explicitly re-emits when fingerprint changes. Conversation-name changes are a concrete candidate; no source rename replay was performed. |
| `google-takeout.location_history` | Possible | `connectors/google_takeout/parsers.ts:81–89` hashes time/coordinates, while accuracy/activity/velocity/altitude are outside key. `index.ts:148–152` emits records after cursor filtering. |
| `google-takeout.youtube_watch_history` | Possible | `packages/polyfill-connectors/src/youtube-watch-history.ts:62–67` hashes watch time + video URL, but stores video title and channel name/URL. `connectors/google_takeout/index.ts:219` emits the result. Metadata changes in a later export can conflict on replay. |
| `google-takeout.search_history` | Possible | `connectors/google_takeout/parsers.ts:115–123` hashes time/query, with product/header outside identity. `index.ts:281` emits it. No changing-header occurrence established. |
| `google-takeout.photos` | **Confirmed** | `connectors/google_takeout/parsers.ts:179–192` hashes content bytes but stores filename/event time/title/description/location. `index.ts:341–375` adds hydration fields; `:393–404` emits every eligible album copy without same-run content-ID deduplication. Duplicate album copies or retry/re-import hydration can therefore produce changed same-key snapshots. |
| `groupme.direct_chat_messages` | **Confirmed** | `connectors/groupme/index.ts:1062–1085` keeps provider message ID and embeds normalized attachments. `:747–748` adds `normalized.blob_id` only after successful upload. `:2138–2145` fingerprint gate emits the changed message after hydration recovery. |
| `groupme.attachments` | **Confirmed** | `connectors/groupme/index.ts:733–771` keeps attachment ID while hydration status/blob/hash change. `:1797–1800` explicitly withholds parent cursor after hydration failure for retry; `:1821–1822` emits changed fingerprints. |
| `imessage.attachments` | **Confirmed** | `connectors/imessage/index.ts:687–713` uses stable source attachment identity and emits every queried attachment with hydration status/error/hash/blob. Later successful hydration changes the same-key record. |
| `netflix-export.viewing_activity` | Possible | `connectors/netflix_export/parsers.ts:674–684` hashes title + normalized day but stores raw date; `:707–720` full-export key excludes country/raw timestamp. Alternative representations or corrected metadata can conflict on replay. No observed export pair established. |
| `signal.reactions` | No found | `connectors/signal/parsers.ts:205–212` derives ID from precisely the three emitted semantic values: message ID, emoji and sender. `index.ts:777` emits that deterministic record. Removal propagation is separate from changed-data duplicates. |
| `signal.attachments` | **Confirmed** | `connectors/signal/index.ts:1121–1145` keys by local attachment path and emits hydration outcome/hash/blob and linked metadata. Retrying the same path after upload availability/failure changes data. |
| `twitter-archive.tweets` | Possible | `connectors/twitter_archive/parsers.ts:71–80` keys by tweet ID but stores favorite/retweet counts and reply screen name. `index.ts:92` emits after creation-time filtering; later export replay can carry changed counters. |
| `twitter-archive.direct_messages` | No found | `connectors/twitter_archive/parsers.ts:116–122` directly maps message ID, participants, creation time and text. `index.ts:146–150` applies cursor and emits. No connector-created mutation found. |
| `whatsapp.messages` | No found | `connectors/whatsapp/parsers.ts:253–261` content-addresses author/time/content/occurrence; `:923–932` derives attachment flag from content. `index.ts:273–283` emits those same inputs. Edited text normally changes the key. |
| `whatsapp.attachments` | **Confirmed** | `connectors/whatsapp/index.ts:776–809` keys attachment independently of upload result, but includes failed/deferred/hydrated status, error and blob. `:839–841` emits changed fingerprints on subsequent imports. |

**Inventory distinction:** both scan files list 31 append-only streams, but they are not identical sets: pinned source adds `github.events`; vendor manifests instead contain `spotify.recently_played`. The pinned Spotify implementation only emits `SKIP_RESULT` for `recently_played` at `connectors/spotify/index.ts:935–947`. That does **not** establish behavior of the older shipped vendor implementation. This review audited pinned TypeScript implementations; vendor manifest overlap alone cannot prove packaged JavaScript behaves identically.


## Shipped-only and seed findings

| Declaration | Classification | Evidence |
|---|---|---|
| Shipped `spotify.recently_played` | Possible | `connectors/spotify/index.js:343–365` fetches and emits recently played records. The key at line 353 is track ID + played-at milliseconds; track name, artist names, album name and context type at lines 357–361 are outside identity. Lines 66–73 intentionally replay the one-millisecond cursor boundary. Metadata changes can therefore produce changed same-key records, including a boundary replay, but no changing provider response was observed. No run-clock field is added to data. This is an actual emitter, unlike the pinned revision's deferred stream. |
| RI seed `reddit.posts` | Confirmed by two local process runs | `reference-implementation/connectors/seed/index.ts:39–44` computes fixture dates from the current clock. Lines 394–400 pair fixed post ID with relative `source_created_at`; lines 595–599 emit those fixtures every run. Two fresh local processes with identical START scope emitted the same key with different data; the changed field was `source_created_at`. |
| RI seed `reddit.comments` | Confirmed by two local process runs | The same seed file at lines 447–451 pairs fixed comment ID with relative `source_created_at`; lines 601–605 emit it each run. The same two-process check confirmed equal keys but changed `source_created_at`. This finding concerns synthetic RI fixtures, not the production Reddit connector. |

The seed reproduction ran `reference-implementation/connectors/seed/index.ts` twice with `START.scope.streams` equal to `posts,comments`, parsed RECORD output, and compared the first emitted record of each stream. Both checks returned `sameKey: true`, `sameData: false`, `changedFields: ["source_created_at"]`. No accounts or network access were used.
