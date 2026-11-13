# LWS copy demo: build plan

Branch `lws-demo`. This is a demo, not a product feature. It does not merge to `main` without an owner review.

## Goal

The DataConnect server copies a person's records into one folder in their Linked Web Storage (LWS). A second, empty DataConnect server rebuilds itself from that folder. A PDPP query then returns the same answer on both servers. LWS is the W3C Linked Web Storage draft (https://github.com/w3c/lws-protocol, commit db64f56). The test server is lws-server (https://github.com/ebremer/lws-server, commit 97e8ace).

Out of scope for the demo: attachments (blobs), grants, tokens, connector credentials, schedules, compaction, encryption, edits to the folder by other apps, field-level enforcement in the storage.

## Facts measured on lws-server (13 Nov 2026)

- Login: the client signs a JWT (alg EdDSA, header `typ: JWT`, `kid: <did>#<multibase part of the did>`; claims `iss = sub = client_id = <did:key>`, `aud` = storage root URL with trailing slash, `iat`, `exp`). It POSTs it as `application/x-www-form-urlencoded` to `<as_uri>/.lws/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<jwt>`, `subject_token_type=urn:ietf:params:oauth:token-type:jwt`, `resource=<storage root>`. The `as_uri` comes from the `WWW-Authenticate` header of any 401. The answer is `{access_token, issued_token_type, token_type: "Bearer", expires_in: 300}`. There is no refresh token: sign a new credential each time. A JSON request body gets 400. The draft calls this suite "self-signed controlled identifier" (lws10-authn-ssi-cid); the older "did:key" suite name is discontinued.
- `authorization_details` (RFC 9396) in the token request is accepted and silently ignored.
- Create a folder: `PUT /path/` with header `Link: <http://www.w3.org/ns/ldp#Container>; rel="type"`.
- Files keep their `Content-Type` (`application/x-ndjson` works). ETags are strong and derived from content: identical bytes give the same ETag.
- `PUT` with `If-None-Match: *`: 201 if new, 412 if it exists. `PUT` with `If-Match`: 204 if current, 412 if stale; without `If-Match` on an existing file: 428. `DELETE` with `If-Match`: 204 if current, 412 if stale. `If-Match: *` on a missing file: 412. The server also accepts a weak `W/` tag; do not rely on that.
- Request bodies over 64 MiB drop the connection with no status. Keep every request under 32 MiB.
- A refused request and a missing file both return 404 (`application/problem+json`). A 404 inside a folder we wrote to is a permission problem.
- Folder listing: `GET` with `Accept: application/lws+json`, 1,000 items per page, next page in `Link: <...>; rel="next"`.
- About 0.5 s per small write. Write few, large files.

## Facts about DataConnect (commit 9a7899a, `reference-implementation/server`)

- Ingest (`ingestRecord` / `ingestRecords`, records.ts:1687, 1732) and explicit deletes (`deleteRecord`, records.ts:6379) write a `record_changes` row in the same transaction, in both SQLite and Postgres.
- Per-stream versions are allocated serially (SQLite `BEGIN IMMEDIATE`; Postgres counter row lock plus a per-connection write fence, postgres-records.ts:1610-1682). Committed versions for one stream never appear out of order, so "last version copied" per stream is a safe cursor.
- Not in `record_changes`: stream reset (deletes history, reuses versions from 1; it advances `connector_instances.record_reset_generation`), connection delete, manifest/identity invalidation (records.ts:6710-6732, 7048-7078), blob uploads, and in-place repairs of the derived columns `cursor_value`, `primary_key_text`, `semantic_time` (postgres-records.ts:754-770).
- `PDPP_CHANGE_HISTORY_LIMIT` (default 0 = keep all) prunes old change rows.
- `records.id` is a SQLite AUTOINCREMENT / Postgres BIGSERIAL. Do not copy it; let the target assign new ids.

## Folder layout

The person gives the server's LWS identity read and write on one folder, e.g. `/dataconnect/`. All paths below are relative to it. Path segments are percent-encoded.

- `index.json`: the only source of truth. A file that is not listed here does not count.
- `{connection}/{stream}/schema.json`: the stream's JSON Schema from the connector manifest.
- `{connection}/{stream}/snapshot-{generation}-{version}-part-{n}.ndjson`: every live record at that stream version. One line per record: `{"key","version","emitted_at","data"}`.
- `{connection}/{stream}/changes-{generation}-{from}-{to}.ndjson`: one line per change: `{"key","version","op":"upsert"|"delete","emitted_at","data"}` (`data` is null for a delete).

All NDJSON files use `Content-Type: application/x-ndjson`, UTF-8, one JSON object per line, each line ending in `\n`.

## Interfaces (TypeScript, ESM, Node 26; match the repo's style)

### `server/lws/lws-client.ts` (wave 1, task A)

```ts
export interface LwsIdentity { did: string; seed: Uint8Array } // 32-byte Ed25519 private seed
export interface LwsClientOptions {
  storageUrl: string;            // storage root, trailing slash
  identity: LwsIdentity;
  fetch?: typeof fetch;          // injectable for tests
  maxRequestBytes?: number;      // default 32 MiB; larger bodies throw before sending
  now?: () => number;            // ms clock, injectable
}
export class LwsPermissionError extends Error {}          // 401 after a fresh token, 403, or 404 under a folder we created
export class LwsPreconditionFailed extends Error { url: string }   // 412
export interface LwsFile { etag: string; contentType: string | null; body: Uint8Array }
export class LwsClient {
  constructor(options: LwsClientOptions);
  token(): Promise<string>;      // cached; renewed when under 60 s remain
  get(path: string): Promise<LwsFile | null>;                       // null on 404
  putIfAbsent(path: string, body: Uint8Array, contentType: string): Promise<string>; // If-None-Match: *; returns etag
  putIfMatch(path: string, body: Uint8Array, contentType: string, etag: string): Promise<string>;
  deleteIfMatch(path: string, etag: string): Promise<void>;
  ensureContainer(path: string): Promise<void>;                     // idempotent; path ends in '/'
  list(containerPath: string): AsyncIterable<{ id: string; type: string[]; format?: string }>; // follows rel="next"
  probeConditionalRequests(scratchContainer: string): Promise<void>; // throws unless If-None-Match and If-Match behave as above
}
```

Uses Node `crypto` for Ed25519 (no new dependency). Retries 429/5xx and network errors with backoff, three times. Never retries 412.

### `server/lws/folder-layout.ts` (wave 1, task B)

```ts
export interface FileEntry { path: string; bytes: number; sha256: string }
export interface ChangeFileEntry extends FileEntry { generation: number; fromVersion: number; toVersion: number }
export interface StreamEntry {
  generation: number;
  schema: FileEntry | null;
  snapshot: { generation: number; version: number; parts: FileEntry[] } | null;
  changes: ChangeFileEntry[];    // ascending, contiguous after snapshot.version
  lastCopiedVersion: number;     // max of snapshot.version and the last change file's toVersion
}
export interface ConnectionEntry { connectionId: string; connectorId: string; manifestRef: string | null; streams: Record<string, StreamEntry> }
export interface IndexFile { format: "dataconnect-lws-v1"; writer: { serverId: string; lastWriteAt: string }; connections: Record<string, ConnectionEntry> }
export interface ChangeLine { key: string; version: number; op: "upsert" | "delete"; emitted_at: string; data: unknown | null }
export interface SnapshotLine { key: string; version: number; emitted_at: string; data: unknown }

export function schemaPath(connectionId: string, stream: string): string;
export function snapshotPartPath(connectionId: string, stream: string, generation: number, version: number, part: number): string;
export function changesPath(connectionId: string, stream: string, generation: number, from: number, to: number): string;
export function encodeNdjson(lines: readonly object[]): { body: Uint8Array; bytes: number; sha256: string };
export function decodeNdjson<T>(body: Uint8Array, expected?: { bytes: number; sha256: string }): T[]; // throws on size/hash mismatch or bad line
export function splitNdjson(lines: readonly object[], maxBytes: number): Array<{ body: Uint8Array; bytes: number; sha256: string }>;
export function emptyIndex(serverId: string, now: Date): IndexFile;
export function parseIndex(body: Uint8Array): IndexFile;   // validates shape; throws on unknown format
export function serializeIndex(index: IndexFile): Uint8Array; // stable key order, so equal content gives equal bytes
```

Pure functions, no I/O.

### `server/lws/change-source.ts` (wave 1, task C)

Read-only adapter over the existing storage, for both backends.

```ts
export interface ChangeSource {
  listConnections(): Promise<Array<{ connectionId: string; connectorId: string; manifestRef: string | null }>>;
  listStreams(connectionId: string): Promise<Array<{ stream: string; schema: unknown | null }>>;
  resetGeneration(connectionId: string): Promise<number>;
  // Ascending by version, starting after `afterVersion`, stopping before the total encoded size passes maxBytes (at least one row).
  // `oldestAvailableVersion` is the lowest version still in record_changes for the stream (null if none), so the caller can detect pruning.
  readChanges(connectionId: string, stream: string, afterVersion: number, maxBytes: number):
    Promise<{ rows: ChangeLine[]; oldestAvailableVersion: number | null }>;
  // All live records and the stream version they reflect, read in one transaction.
  readSnapshot(connectionId: string, stream: string): Promise<{ version: number; generation: number; lines: SnapshotLine[] }>;
}
export function createChangeSource(/* whatever the existing storage handle is */): ChangeSource;
```

### `server/lws/copy-worker.ts` (wave 2, task D)

```ts
export interface CopyWorkerOptions {
  client: LwsClient; source: ChangeSource; folder: string; serverId: string;
  maxChangeFileBytes?: number;   // default 8 MiB
  now?: () => Date; log?: (event: string, detail: object) => void;
  crashPoint?: (name: string) => void; // test hook; throws to simulate a crash
}
export class CopyWorker {
  constructor(options: CopyWorkerOptions);
  runOnce(): Promise<{ filesWritten: number; streamsCopied: number }>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}
```

Rules:
1. On first use: `probeConditionalRequests`, `ensureContainer(folder)`, then create `index.json` with `putIfAbsent`. If it exists and names another writer, stop and log `lws.writer_conflict`. Never take over a folder.
2. Each pass reads `index.json` and its ETag. Before every index write, check that the writer is still this server.
3. Per stream, if there is no snapshot, or the reset generation changed, or `oldestAvailableVersion > lastCopiedVersion + 1` (pruned): write a fresh snapshot (parts via `splitNdjson`, `putIfAbsent`), then replace the stream entry in the index (new snapshot, empty change list), using `putIfMatch`.
4. Otherwise read changes after `lastCopiedVersion` up to `maxChangeFileBytes`; write `changes-{g}-{from}-{to}.ndjson` with `putIfAbsent`. On 412, GET it: if the sha256 matches, continue; if not, stop with `lws.content_conflict`. Then append it to the stream entry and write the index with `putIfMatch`. On an index 412: re-read, re-check the writer, retry.
5. Write `schema.json` when it is missing or changed.
6. Crash safety: a crash between any two steps leaves the folder valid, because only files in `index.json` count and every file name is a function of its content range. Name the crash points `after-data-file`, `after-index-write`, `after-snapshot-part`.
7. Unlisted files older than one hour are deleted, only between passes.

### `server/lws/import.ts` (wave 2, task E)

```ts
export interface ImportReport { connections: number; streams: number; records: number; changes: number; files: number }
export function importFromLws(options: { client: LwsClient; folder: string; serverId: string; target: /* existing storage handle */ unknown }): Promise<ImportReport>;
```

Rules: refuse unless the target has no records. Read `index.json`; take over the writer entry with `putIfMatch` (import is the explicit owner action that moves a folder to a new server). Create each connection with its original id. For each stream, load the snapshot parts, then the change files in version order, checking every file's size and sha256 against the index; stop on any mismatch. Write records and `record_changes` with their original key, version, `emitted_at` and reset generation; let the target assign `records.id`. Set each stream's version counter to the higher of the last change version and the snapshot version. Recompute `cursor_value`, `primary_key_text` and `semantic_time` the way normal ingest does. Then run the existing search and read-model rebuilds.

### Wiring (wave 3, task F)

- Start the worker at server boot when `PDPP_LWS_STORAGE_URL` is set. Other settings: `PDPP_LWS_FOLDER` (default `/dataconnect/`), `PDPP_LWS_IDENTITY_FILE` (JSON `{ "did": "...", "seed": "<base64url>" }`), `PDPP_LWS_SERVER_ID` (default: hostname), `PDPP_LWS_INTERVAL_MS` (default 10000).
- A CLI script `reference-implementation/scripts/lws-import.ts`, run as `npm run lws:import`.
- An offline end-to-end test: fake LWS server, server A ingests sample records with an update and a delete, worker copies, server B imports, the same PDPP query on A and B returns identical JSON.

### Live demo (wave 4, task G, run locally with Docker)

`deploy/lws-demo/`: docker compose with lws-server (built from source at 97e8ace) and two DataConnect servers; synthetic Spotify listening data (no real personal data); a "music stats site" PDPP client that asks for 2025 plays with artist names and play dates only; a script for the demo steps in the design (copy, crash, rebuild, compare, and the token test with and without `authorization_details`). Output: `deploy/lws-demo/REPORT.md` with every command and result.

## Testing

Tests live in `reference-implementation/test/lws-*.test.ts`, with the fake server at `reference-implementation/test/helpers/fake-lws-server.ts`. The fake must reproduce every lws-server fact above, including 428, 412, content-derived ETags, 404 for refused, paging, and the 300-second token. Run tests the way the repo's `ri-changed` check does (`node --test --import tsx --import ./scripts/hermetic/preload.ts`, plus `tsc --noEmit`).
