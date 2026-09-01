# Server & Repairs embed prototype

What this branch adds: a "Server & Repairs" tab in the DataConnect desktop
app that embeds the PDPP reference server's own owner UI, authenticated as
the owner, without the app copying or storing any of the data it shows.

This is the OS-independent half only. It does not touch per-OS process
isolation (bwrap/unshare/sandboxing) — that decision is still pending and
this branch does not assume an answer either way.

## Run it

You need two things running: a local `pdpp` checkout with `PDPP_OWNER_PASSWORD`
set, and this app.

1. In a `pdpp` checkout (branch from `origin/main`), start the composed
   reference server with owner auth enabled:

   ```bash
   cd ~/code/pdpp   # or wherever your checkout lives
   PDPP_OWNER_PASSWORD=devpassword pnpm dev
   ```

   This serves the composed browser-facing origin at `http://localhost:3000`
   (see `reference-implementation/README.md`, "Same-origin local reference
   composition"). Confirm it's up:

   ```bash
   curl -s http://localhost:3000/.well-known/oauth-protected-resource | head -c 200
   ```

2. In this repo, set the same password so the app can sign in as the owner,
   and run the desktop app in dev mode:

   ```bash
   export PDPP_OWNER_PASSWORD=devpassword
   npm run tauri dev
   ```

   (`npm run tauri dev` runs `pretauri:dev` first, which needs network access
   to fetch connector/runtime dependencies — see Known issues below if that's
   blocked in your environment.)

3. Click "Server & Repairs" in the top nav. The app will:
   - health-check `http://localhost:3000` (or spawn its own copy — see next
     section) until it responds,
   - sign in as owner via `POST /owner/login`,
   - open an embedded webview showing the reference server's UI, signed in.

### Letting the app spawn the server itself

By default the app expects you to already have `pnpm dev` running in the
`pdpp` repo (step 1 above) — that's the "point at a locally running server"
fallback the task allowed. If you'd rather have the app spawn it:

```bash
export PDPP_REFERENCE_CHECKOUT=/absolute/path/to/your/pdpp/checkout
export PDPP_OWNER_PASSWORD=devpassword
npm run tauri dev
```

With `PDPP_REFERENCE_CHECKOUT` set, `start_reference_server` runs `pnpm dev`
in that checkout as a supervised child process instead of just health-checking
an existing one.

### Configuring the origin

If your reference server isn't on the default port, set
`PDPP_REFERENCE_SERVER_URL` (e.g. `http://localhost:3005`) before launching
the app — both the health check and the login/embed calls use it.

## What's real

- **Process lifecycle** (`src-tauri/src/commands/ref_server.rs`): spawn,
  health-wait (`GET /.well-known/oauth-protected-resource` polling), stop
  (SIGTERM to the process group, then SIGKILL), restart-on-crash (bounded to
  3 attempts with backoff via a watcher thread), and cleanup on app exit.
  This mirrors `commands/server.rs`'s personal-server supervision pattern,
  which this repo already ships.
- **Auth handoff** (`login_reference_server`): does `POST /owner/login` with
  `Content-Type: application/json` — the exact same endpoint and mechanism a
  human hitting the login form uses, not a backdoor. JSON bodies are exempt
  from the server's CSRF requirement by the server's own design (see
  `reference-implementation/server/owner-auth.ts`'s `isJsonRequest`), so no
  privileged shortcut was added on either side.
- **Embedding** (`src-tauri/src/commands/ref_server_view.rs`): a real Tauri
  child `Webview` (not an `<iframe>` — this app's CSP has no `frame-src`
  allowance, and weakening it just for one tab felt like the wrong tradeoff),
  positioned to track a React placeholder `<div>` via `ResizeObserver`. The
  owner-session cookie is set natively via `Webview::set_cookie` before the
  first navigation.
- **Data ownership**: unchanged. The app never touches the reference
  server's database. It holds a session cookie in the webview's cookie jar,
  nothing else. Nothing new is written to Tauri's app-data directory by any
  of this branch's code.

## What's stubbed / honestly incomplete

- **Bundling**: the reference server is not a binary this app ships yet.
  `reference-implementation/` doesn't exist in this repo — it's an
  intentionally-empty placeholder waiting on Move B (see
  `reference-implementation/README.md` in this repo). Until that lands,
  "start" means spawning `pnpm dev` in a checkout you point at, the same
  "real child process, supervised, health-checked" shape a bundled binary
  spawn would need — the branch to change is `start_reference_server`'s
  `Some(checkout_dir)` arm, swapping the `pnpm dev` `Command` for a resolved
  bundled-binary path (mirror `get_bundled_personal_server` in
  `commands/server.rs`).
- **Password source**: `PDPP_OWNER_PASSWORD` must currently be set in the
  app's own environment, matching whatever the reference server was started
  with. There's no UI to enter it and no secure-storage integration. A real
  build needs either a provisioning step that shares this secret once at
  first-run, or (better) a proper owner-auth upgrade on the reference server
  itself that this app can drive without a shared static password — the
  reference server's own docs already flag its password auth as a
  placeholder, not a durable auth story.
- **Restart-on-crash only covers the app-spawned case.** If the app attached
  to an already-running server it didn't spawn (`managed: false`), it won't
  try to restart it if that server dies — there's nothing for it to restart.
  It will report the failure via `reference-server-error` the next time you
  try to reconnect.
- **No automated tests were added.** The Rust side compiles clean
  (`cargo check`, `cargo clippy --no-deps`, `cargo fmt` all pass on the new
  files) but I did not write unit/integration tests for the new commands —
  time-boxed prototype scope. `src-tauri/src/commands/server.rs` has no
  tests either, so this matches the existing pattern for this kind of module
  in this repo, but it's still a gap.
- **Frontend typecheck could not be verified end-to-end.** `npm install`
  fails in this sandbox (`EALLOWGIT` — a private git dependency,
  `@opendatalabs/data-connectors-tools`, is blocked) before any package is
  installed, so `tsc -b` / `vitest` could not be run. The new/edited
  TypeScript files (`src/hooks/useReferenceServer.ts`,
  `src/pages/server-repairs/index.tsx`, `src/App.tsx`,
  `src/components/navigation/top-nav.tsx`, `src/config/routes.ts`) were
  hand-reviewed against the existing patterns they follow
  (`usePersonalServer.ts`, `pages/personal-server/index.tsx`) and against
  the exact camelCase/snake_case field names the new Rust commands return,
  but this is not a substitute for a real typecheck. Run
  `npm run typecheck` yourself once dependencies can install.
- **Not manually verified end-to-end in a browser/app window** — same
  sandbox constraint (no network for `npm install`, so the app itself
  couldn't be built or launched here). The Rust supervision logic and the
  server-side auth mechanism were each verified independently (compiled;
  and the login flow was verified by reading the actual
  `reference-implementation/server/owner-auth.ts` handler in `pdpp`, not
  assumed), but the two halves have not been observed working together in a
  running window.

## What the pending isolation decision would change

None of this branch's code path changes based on the isolation decision —
it's scoped to process spawn/health/stop/auth/embed, which is OS-independent
either way. But the decision does gate what "start" is allowed to assume:

- If per-OS sandboxing (bwrap/unshare/Windows job objects/etc.) becomes a
  requirement, `start_reference_server`'s spawn call needs to go through
  whatever isolation wrapper gets chosen, the same way collector children
  already get process-group isolation
  (`reference-implementation/runtime/index.ts:2292-2308` in `pdpp`, per the
  cross-platform-connector-runtime research). Right now the reference server
  is spawned directly, with only process-group signaling (SIGTERM/SIGKILL to
  the group) for cleanup — appropriate for a trusted first-party server
  process, not appropriate if the isolation decision later requires treating
  it like an untrusted connector child.
- If bundling requires the reference server to run inside a container/VM
  (unlikely for this component, given it's first-party code, but worth
  naming), the health-check-and-attach fallback path already gives a shape
  for "the app doesn't manage the process directly" that would still work.
- The restart/crash-recovery watcher assumes it can `SIGTERM` a process
  group it created. A namespaced/sandboxed child might need a different
  termination handshake (e.g. asking a supervisor process to tear down a
  namespace) — that would replace `kill_process_group` calls in
  `ref_server.rs`, not the surrounding lifecycle state machine.
