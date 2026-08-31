# Bare-metal (no Docker) run spike: can pdpp's reference-implementation/server satisfy D-04/D-05?

Spike date: 2026-08-27. Scope: Phase 1.3 step 2 of the reorg execution plan — answer
"can the merged server run bare-metal, no Docker" *before* Move B execution depends on
the answer. No pdpp code is merged or vendored by this spike; it is analysis against a
read-only reference clone plus this repo's existing `personal-server/` packaging code.

## Verdict: PASS, with two concrete gaps to close during Move B, not before

`data-connect`'s `personal-server/` already proves the pattern this needs. The main new
work is a second native-dependency set (Postgres client, not just SQLite) and resolving
which storage backend Move B actually ships with.

## What `personal-server/` already solves (reusable as-is)

- **Single self-contained executable**: `@yao-pkg/pkg` compiles `personal-server/index.js`
  into one binary per target (`node22-{macos-arm64,macos-x64,win-x64,linux-x64}` —
  `personal-server/package.json:16-29`, `personal-server/scripts/build.js`). Shipped via
  Tauri's `bundle.resources`, spawned with plain `std::process::Command`
  (`src-tauri/src/commands/server.rs`) — no `externalBin`/sidecar machinery needed.
- **Native-addon packaging**: `better-sqlite3` can't live in pkg's snapshot, so
  `scripts/build.js` copies the native module to disk beside the binary and patches
  `require()` resolution to find it there at runtime
  (`personal-server/scripts/build.js:255-278,366-396`).
- **Readiness/lifecycle wiring**: stdout-JSON-line protocol (`{"type":"ready","port":N}`)
  plus Tauri event re-emission, process-group SIGTERM->SIGKILL shutdown, stale-port
  cleanup via `lsof`+`SIGKILL` on startup — all generic, all directly reusable by a new
  server as long as it emits the same ready-line convention on its own stdout.

## What's different about pdpp's reference-implementation/server

Read directly from a local pdpp reference clone (`reference-implementation/package.json`,
`reference-implementation/server/db.ts`, `postgres-storage.ts`,
`postgres-test-database-guard.ts`). This clone may be stale by the time Move B executes —
treat these as directional findings to re-verify against pdpp's actual HEAD at that time,
not as frozen facts.

1. **Dual storage backend, not SQLite-only.** `reference-implementation/package.json`
   depends on both `better-sqlite3` (^13.0.3) and `pg` (^8.23.0), plus `sqlite-vec`
   (^0.1.9) for embedding search. `postgres-storage.ts` and a dedicated
   `postgres-test-database-guard.ts` exist as first-class code, not test-only scaffolding.
   **Open question for Move B, not this spike**: does the desktop-bundled deployment
   target SQLite-only (matching `personal-server`'s existing precedent, zero extra
   infra) or does it need a bundled/embedded Postgres too? If the latter, that's new
   packaging surface `personal-server` has no precedent for — embedding a full Postgres
   binary is a materially different problem than copying a native Node addon.
   **Recommendation**: scope Move B's initial desktop target to the SQLite path only;
   treat Postgres as a server/cloud-deployment concern out of scope for the Tauri
   bundle, unless the owner says otherwise.
2. **No separate migration-runner step observed.** No `migrate` script, migration
   directory, or schema-versioning table found in the reference clone. Schema creation
   happens inline at startup (`CREATE TABLE IF NOT EXISTS`-style statements found directly
   in `server/db.ts` and `server/postgres-storage.ts`). This is actually favorable for
   bare-metal: no manual migration step to wire into first-run bootstrap, matching
   `personal-server`'s existing "loadConfig() creates default if missing" pattern. Still
   needs confirmation against pdpp's actual HEAD at Move B time — the scripts directory
   also contains one-off *data* migrations (e.g. `migrate-slack-env-config-to-spine.ts`)
   that are unrelated to schema bootstrap and must not be confused with it.
3. **No build step — runs TS directly via the Node loader.** `reference-implementation`'s
   `server`/`dev` scripts run `node --env-file-if-exists=... server/index.ts` directly
   (relying on Node's native TS stripping), not a compiled `dist/`. `personal-server`
   builds via `esbuild` first, then `pkg`s the bundle. Move B's packaging step will need
   an equivalent bundle/compile stage before `pkg` (or whatever single-binary tool is
   chosen) can consume it — `pkg` does not run TS source directly. This is expected,
   ordinary packaging work, not a blocker.
4. **No Docker dependency found** in the reference-implementation package itself,
   consistent with the existing `DATACONNECT-AUDIT.md` finding that this repo already has
   zero Docker runtime coupling. Nothing to remove on that axis.

## Concrete gaps to close during Move B execution (not before)

1. Confirm with the owner: SQLite-only bundled desktop target, or does Postgres need to
   ship too? Recommend SQLite-only for the initial cutover.
2. Add an esbuild (or equivalent) bundle step for `reference-implementation/server`
   before `pkg` compilation, mirroring `personal-server/scripts/build.js`'s existing
   esbuild → pkg pipeline.
3. Re-verify points 1-2 above against pdpp's actual HEAD immediately before Move B
   executes — this spike is based on a local reference clone that may already be stale.
4. Normalize the `.data-connect` vs `.dataconnect` directory-naming inconsistency
   already flagged in `DATACONNECT-AUDIT.md` finding #7 before introducing a third
   naming convention for the new server's data directory.

## What this spike deliberately does NOT do

- Does not merge, vendor, or copy any pdpp code into this repo.
- Does not modify `personal-server/` — it is read-only prior art here.
- Does not attempt to actually run `reference-implementation/server` bare-metal end to
  end (that requires the pdpp checkout and its full dependency tree, out of scope for a
  paper spike that must not touch pdpp).
