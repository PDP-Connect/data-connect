# Attach desktop app to an existing server

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 5. Attach desktop app to an existing server

**Who starts it:** owner. **Where:** tray → “Connect to a server...” or, on server, Settings → “Attach a desktop app” → “Create pairing code”. **Forms:** desktop plus any remote Core server. **Evidence:** V in `src-tauri/src/attach_window.rs:1`, settings component, server pairing docs.

1. [V] On the server the owner creates a one-time code. The page shows “Creating…”, then address, pairing code, Server ID, link, and countdown; copy buttons report “Address copied.” / “Code copied.” / “Link copied.” or “Could not copy. Select the <address/code/link> and copy it by hand.” Code expires in 10 minutes; helper: “A code works once and expires in 10 minutes. Paired computers appear under Owner sessions and can be signed out there.” [apps/console/src/app/(console)/settings/desktop-pairing-setting.tsx:39-46,60-125,162-223]
2. [V] Tray opens a separate `Connect to a server` window. Paste a server address or pairing link. It previews/parses URL, contacts server, checks signed server identity before sending code/password, and shows Server ID. [src-tauri/src/attach_window.rs:50-81,177-200,225-307]
3. [V] Plain HTTP to a non-loopback server requires the explicit checkbox “I trust this network”; warning text in code is “This address uses plain HTTP. Tick "I trust this network" to continue, or use an https:// address.” HTTPS is otherwise expected. [src-tauri/src/attach_window.rs:213-223]
4. [V] Confirm and connect with pairing code; if server is older/no pairing route, fallback “Use the owner password instead”. Unverified server identity requires explicit tick-box. An existing address answering with a different key does not send a credential and asks the owner to connect again. [docs/design/desktop-remote-attach.md:36-53,79-85]
5. [V] Attached desktop opens the server console and authenticates through a stored owner session. Session is in OS keychain; attachment metadata in `attach.json`; session is listed under Owner sessions. Disconnect tray action revokes server session best-effort, deletes local attachment and restarts in “This computer” mode. [docs/design/desktop-remote-attach.md:46-77]

Failures include invalid URL, untrusted HTTP, unsupported server identity, changed key, server unreachable, and “DataConnect is already connecting. Wait for it to finish.” Environment variables `DATACONNECT_RI_URL` or `DATACONNECT_CONSOLE_URL` disable this flow and produce “Set by environment: DATACONNECT_RI_URL or DATACONNECT_CONSOLE_URL is set. Unset it and restart DataConnect to attach from here.” [src-tauri/src/attach_window.rs:22-23,85-90,177-223,274-287,350-358]

**Rough edges:** doc `docs/design/desktop-remote-attach.md:1` has a “Status: proposed” header although branch code implements the flow; some wording in that document describes a previous experiment rather than current code. Attached desktop cannot run the server’s browser-profile connectors on the desktop; it sees connectors available on the remote server only. [docs/design/desktop-remote-attach.md:3-20,59-68]

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `settings`. **Combined isolated run:** `settings`: **pass**.

**What it verifies:** The capture reaches the web-side pairing entry at both viewports.

**Reaches:** The Settings page shows “Attach a desktop app”, “Pair the DataConnect desktop app with this server”, and “Create pairing code”.

**Stops at:** It cannot open the native “Connect to a server...” window, redeem a pairing code in Tauri, verify server identity, or persist an OS keychain session.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: settings"
```

**Evidence:** `evidence/settings/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The desktop pairing panel is visible in the web console. The Tauri window and keychain are outside this HTTP-only harness.
