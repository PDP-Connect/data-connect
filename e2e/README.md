# Owner-journey e2e check

Runs a headless-browser check against a **running** console and asserts on
what the owner actually sees: the connector catalog on `/sources/add`, and
the Remote access / About sections on `/settings`.

## Run it

```sh
E2E_BASE_URL=http://127.0.0.1:<port> E2E_OWNER_PASSWORD=<password> npm run test:e2e
```

- `E2E_BASE_URL` — origin of a running console (Tauri desktop console, or the
  personal-server's `apps/console` bundled console). Defaults to
  `http://127.0.0.1:1421`.
- `E2E_OWNER_PASSWORD` — the target instance's actual `PDPP_OWNER_PASSWORD`.
  **This is not necessarily the contents of `~/.tmp/unified-owner-password`**
  — that file is written once and can go stale relative to a specific
  running process. If login fails, read `PDPP_OWNER_PASSWORD` out of the
  target process's own environment (`tr '\0' '\n' < /proc/<pid>/environ | grep PDPP_OWNER_PASSWORD`).

### Finding a running console's port

The console is a separate HTTP server (Next.js `apps/console`), not the
Tauri window's native webview — Playwright cannot drive the webview directly
over its remote-debugging port. To find the console's port for a given
running app instance, locate its `console/launch.mjs` child process and read
the port it bound:

```sh
pgrep -af 'reference-stack/console/launch.mjs'
# then, for the next-server child of that pid:
ss -tlnp | grep 'next-server'
```

curl the candidate port; the console redirects unauthenticated requests to
`/owner/login` with a 307, and the login page's `<title>` is
`DataConnect — Owner sign-in` (or `<instance name> — Owner sign-in` when
`PDPP_INSTANCE_NAME` is set). Once logged in, `/settings`
renders with `<title>Settings</title>`.

## What this does not catch

This check drives a plain headless browser against the console's HTTP port.
It does **not** run inside the Tauri webview, so it cannot exercise bugs that
only occur through the Tauri IPC bridge (e.g. a blocked `invoke()` call that
only fails inside the packaged app). The "not allowed" / "Plugin not found"
assertion on Settings will only catch that class of bug if the error banner
text is rendered into the page owner regardless of transport — verify this
assertion's honesty against a real Tauri-window repro before trusting a green
run to mean the IPC bug is fixed.

## CI status

Not wired into a required gate yet. See the repo's `E2E-JOURNEY-0918.md`
report for what's needed before this can gate merges (a bootable reference
server on CI, a stable owner-password provisioning story, and a decision on
how to start the console under CI without the currently-broken `npm run
tauri:dev` path).
