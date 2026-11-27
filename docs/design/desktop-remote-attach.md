# Desktop attach to a remote DataConnect server

Status: proposed (2026-11-17). Build target: one PR into `main`.
Owner question (2026-11-13): "be able to attach to a remote instance like how t3 code can". This is in addition to Gozar giving a server a public address (PR #679). Gozar answers "where is the server". This document answers "how does the desktop use it".

## What exists today (measured, 2026-11-17)

An experiment ran the released desktop (v0.8.6, isolated HOME, display and D-Bus session) against a second server: the published Core Docker image on its own port and data volume. The only switch was the developer escape hatch (`DATACONNECT_RI_URL`, `DATACONNECT_CONSOLE_URL`; `src-tauri/src/unified.rs:685`, `src-tauri/src/commands/ref_server.rs:14-20`).

| Question | Result |
| --- | --- |
| One URL or two? | One. A Core server serves the console, `/owner/login` and the RI paths on one public origin. Both variables take the same value. |
| Does the console render and read remote data? | Yes. The page footer shows the remote address; the remote audit log shows "DataConnect console" reads. Works over plain HTTP at a dotted, non-loopback hostname. |
| Does sign-in work? | Only with the owner password in the desktop's environment (`PDPP_OWNER_PASSWORD`). Without it the login returns 401, no window opens and the log has one error line. |
| Does every hostname work? | No. `http://localhost:PORT` fails with "Failed to construct authentication cookie": `webview_cookies.rs:123` parses the cookie with `soup::Cookie::parse`, which rejects the single-label domain `localhost` on Linux. `127.0.0.1` and dotted names work. |
| Sources the remote can run | The remote's "Add source" page offers Claude Code and Codex (filesystem collectors) and lists 29 connectors, including every browser connector, as "not available on this platform". |
| Filesystem data from the desktop machine | Works with the existing push path. `@pdpp/local-collector@2.5.2` enrolled against the remote with a one-time code; the remote accepted 30 records and showed the device under Device exporters. |
| Anything still local in attach mode | The desktop still creates a local owner credential and starts the local browser-surface host (`unified.rs:808`). The host receives no remote lease and does nothing. |

The assumption "the console honors the URL everywhere" held. The console is the server's own web app, so there is nothing else in it to redirect. The two real gaps are how the desktop signs in and what runs where.

## Prior art

Full notes: `~/code/divan/cross-platform-connector-runtime/a-remote-dataconnect-server-should-treat-the-desktop-as-two-principals-an-owner-client-with-a-narrow-origin-pinned-bridge-and-an-outbound-dialing-worker-whose-connectors-and-browser-run-locally.md` (T3 Code, VS Code Remote and Tunnels, JetBrains Gateway, Zed, Home Assistant, Nextcloud, Tailscale, Kubernetes, GitHub runners) and the entry on pairing in Jupyter, Syncthing and VS Code tunnels listed under "Research gaps" below.

What decided the design:

- **T3 Code.** A one-time token (5 minute TTL) is exchanged for a scoped session (30 days). Pairing secrets are returned once, never by a read model. Revocation is per session. A saved address is first checked against the server's public descriptor, so "a saved LAN address that a different machine answers on another network receives no credential". Execution never moves: the client reaches a server, and the server runs the work. T3 has no client that is also a worker.
- **Nextcloud Login Flow v2.** A desktop client that signs in to a server it does not run gets one revocable credential per client, delivered exactly once. A 401 means "ask the user", not "retry".
- **Home Assistant companion app.** The one product where a device is both UI client and data source. It uses two credentials: an OAuth session for the UI and a separate per-device registration for data.
- **VS Code Remote.** The client never has a "switch" that silently keeps using the old server. The status indicator names the host.
- **Tauri.** A webview at a remote origin gets no IPC bridge unless a capability grants one. The console window is `WebviewUrl::External` with no grant, and this design keeps it that way.

## Decisions

### 1. How the owner adds a server

Pairing code first, owner password as the fallback.

1. In the server's console the owner opens Settings, "Attach a desktop app", and presses "Create pairing code". The console shows a code (`ABCD-EFGH-JKLM`, 60 bits), an expiry (10 minutes), the server's address and Server ID, and an https link `<origin>/settings#code=<code>&key=<public key>`. The link carries a pairing secret that is useful for 10 minutes once, and the server's public key. It carries no credential. The desktop does not handle `vana://` links for attach.
2. In the desktop the owner opens the tray menu, "Connect to a server...". A small window (`public/attach.html`) takes one field: a server address or the pasted link. Continue contacts the server and shows the server, its Server ID, whether it matches the link, and a pairing code field prefilled from the link. The window asks for one confirmation before the code or password is sent.
3. Fallback for servers without the pairing route (any server released before this change): the same window offers "Use the owner password instead". The password is used once for `POST /owner/login` and is never stored. The session lasts 7 days (the server's fixed session TTL), then the desktop asks again.

The pairing code is not a credential for reading data. Redeeming it needs network reach to the server, and it is single use.

### 2. How the desktop is authorized

- The server mints an ordinary owner session at redemption, labeled `DataConnect desktop (<hostname>)`, 30 days (T3 parity), and returns the opaque session id once in the JSON response. This reuses `owner-session.ts`: sessions are hashed server-side, listed in Settings, revocable one by one, and revoked all at once when the owner password changes. No new credential table and no migration.
- Pairing codes live in the server's memory (single process, 10 minute TTL, single use, throttled by the existing login rate limiter (`owner-login-rate-limit.ts`)). A server restart discards pending codes. That is acceptable for a 10 minute artifact and keeps the change free of schema work.
- The desktop's Rust side stores the session id in the OS keychain, keyed by origin. If the keychain is unavailable it holds the session in memory only, shows a notice ("you will pair again after restart"), and writes no file. The existing 0600 fallback for the managed stack's own password is not reused here. This keeps tokens out of plain files.
- Tokens stay out of the browser. The webview receives the session only as an `HttpOnly` cookie, installed by the same native path as today (`webview_cookies.rs`). The remote origin has no IPC bridge. `fetch` calls to the pairing routes happen in Rust.
- On launch the desktop sends the stored session to `GET /owner/session`. 204 means signed in. 401 means expired or revoked: the desktop opens the attach window with "This pairing ended. Pair again." and never loops.
- The session is sent only to the stored origin over a client that does not follow redirects, and only after `GET /.well-known/oauth-protected-resource` identifies a PDPP server.

### 3. Which work runs where

This is the part the experiment changed.

| Source kind | Runs on | Works in this PR |
| --- | --- | --- |
| Console, schedules, grants, search, MCP and everything the server does for itself | The remote server | Yes. The console is the server's own. |
| Connectors the remote can run (Core offers server-side filesystem collectors) | The remote server | Yes, as the remote offers them. |
| Filesystem sources on the desktop machine (Claude Code, Codex) | Desktop machine, pushed to the remote through the existing device-exporter enrollment | Works today through `@pdpp/local-collector` (measured). The console shows the one-time enrollment code. The desktop does not start the collector in this PR. |
| Browser connectors (Amazon, ChatGPT, banks) | Today only on the machine whose browser holds the login: "This computer" | **No, while attached.** The remote shows them as "not available on this platform". |

Why browser connectors cannot be fixed by wiring: the server would have to dial the desktop's browser, and Chrome's DevTools server binds loopback only and rejects foreign `Host` and `Origin`. Every shipping product that reaches a user's browser from elsewhere has the browser side dial out. The corpus design for this (outbound authenticated channel per desktop; the desktop runs the signed connector locally and ships batches through the existing durable outbox and idempotent ingest routes; the server never gets raw CDP to a logged-in profile) is the follow-up. It needs a server-to-device run channel and per-device placement, both absent today. Doing it here would triple the PR. This document names it so the attach feature does not close the door.

The requirement that any surface syncs with any surface, read as a constraint on this design: the desktop gets no private server API. Pairing mints the same owner session a browser sign-in mints, so a browser, a phone or a CLI can use the same route. Data from the desktop machine reaches the remote through the public device-exporter routes any other client uses. The attach feature adds no desktop-only path to data. If the intended scope is wider, such as replication between two instances, say so; it is not in this PR.

### 4. Switching and disconnecting

- The tray header names the active server: `This computer` or `Attached to <host>`. The status line while starting says which.
- Tray items: `Connect to a server...` (when local), `Disconnect from <host>` (when attached).
- Disconnect revokes the session on the server (best effort; local deletion happens either way and the notice says whether the server confirmed), deletes the keychain entry and `attach.json`, then restarts the app into "This computer". Local data was never touched and returns.
- Attach writes `attach.json` (origin, label, paired-at; no secrets) in the app data directory and restarts the app into the attached state. Switching by restart is deliberate: the unified stack reads attach state in seven places (`attach_mode()` callers), and one mode per process keeps each of them correct. A live swap would need all seven to tolerate a mid-run change. Local and remote never run in the same process.
- `DATACONNECT_RI_URL` and `DATACONNECT_CONSOLE_URL` keep priority over the saved attachment (developer escape hatch). The attach window says "Set by environment" and disables itself when they are set.
- Attaching never deletes the local database or keys, and the app does not start local sidecars while attached.

### 5. How it reaches the server

- Any `http(s)` origin. No provider knowledge: a Gozar route, a Cloudflare tunnel, a LAN name, Tailscale and `localhost` are all just origins. One origin per attachment. If an address changes, the owner re-pairs; a stable Gozar hostname makes that rare. (T3 keeps an ordered route list. This design does not, because the first user has one route.)
- `https` is required unless the host is loopback or the owner ticks "I trust this network" for plain HTTP. The window shows the warning text. The experiment worked over plain HTTP on a LAN, so the rule is policy, not a technical limit.
- Fix the cookie install for single-label hosts (build the native cookie from fields, not by parsing a header string) so `localhost` and LAN names work.
- Server identity is pinned. The server holds an Ed25519 key pair per instance (`<PDPP_DATA_DIR>/instance-identity.json`, 0600). Before any code or password is sent, the desktop posts a fresh nonce to `/owner/desktop-pairings/identity` and checks the signature; the owner sees the Server ID (first 10 bytes of SHA-256 of the key, base32) and confirms. The key is stored with the attachment (`server_key` in `attach.json`) and checked again with a fresh nonce before every send of the stored session. The signed text is `dataconnect-instance-proof-v1\n<origin>\n<nonce>`, where the origin is the canonical origin (`url.origin` form). A loopback dial also accepts proofs signed for the other loopback names (`localhost`, `127.0.0.1`, `[::1]`) with the same scheme and port, because a local Docker server signs its configured name. A changed key, a bad proof or a 404 from a pinned server sends nothing, keeps the pairing record and offers Disconnect and Connect again. A server that cannot prove its identity connects only by owner password, after an explicit tick-box, and is stored unpinned.
- Why this pin, from the prior-art survey (divan entry `pairing-in-t3-vscode-tunnels-tailscale-plex-and-1password-...`): none of T3 Code, VS Code Tunnels, Tailscale, Plex or 1Password pins a server key. The first four rely on an account directory or public-CA TLS; 1Password states that pinning is not implemented and adds a mutual proof. This design pins an app-layer key, not the TLS certificate, because a self-hosted server has no vendor directory and a hostname can be reassigned, and because pinning the key rather than the certificate avoids the rotation failure that 1Password cites.

## What this PR builds

1. Server: `POST /owner/desktop-pairings` (owner session and CSRF; returns code, link, expiry) and public `POST /owner/desktop-pairings/redeem` (code and label in, session id and expiry out, once). In-memory store, 10 minute TTL, single use, rate limited. Session TTL becomes a parameter of issue (30 days for pairings; 7 days stays for sign-in).
2. Console: Settings section "Attach a desktop app" (create code, show code and link, countdown). Paired desktops already appear in the existing owner-sessions list and can be revoked there.
3. Desktop: attach window, keychain-backed attach store, `attach.json`, attach-aware bootstrap (a stored session replaces the password login), tray items, disconnect with server revoke, and the native cookie fix.
4. Tests: server (pairing mint, redeem, expiry, single use, rate limit, 30-day session, revoke), desktop Rust (cookie for `localhost`, attach store round trip with a fake keychain, URL and link parsing, https policy, bootstrap picks session over password, env override wins), console (action and component tests), and an end-to-end run with the released desktop binary against a Core image built from this branch.
5. `PAIRING-WALK-ATTACH.md`, dry-run by me before handing over.

## Expect it to work because

- The desktop's server URL is already one seam, and the experiment showed the console follows it with no other change.
- The sign-in problem is solved by an object that already exists: an owner session, with listing, revocation and password-change revocation, minted through the same controller the login route uses (`owner-session.ts:368`).
- The likeliest wrong assumption was that the console and sync paths honor the URL everywhere. The experiment tested it and it held; the failures were cookie parsing, sign-in and connector availability, which this design targets.
- Remaining risk: Tauri keychain behavior on the target machine. The existing code already falls back and logs when the keychain write fails; this design degrades to in-memory with a visible notice rather than to a file.

## Non-goals and follow-ups

- Desktop as a worker for browser connectors (above). Largest user-visible gap.
- Refresh of a 30 day session without re-pairing (T3 has none either).
- Ordered routes per server.
- DPoP-bound sessions. Useful when a server is reachable by many networks; not needed to test.
- Several saved servers and a switcher. One attachment at a time.

## Research gaps

Jupyter, Syncthing and T3's own pairing docs were researched separately and captured in the divan entry named by the research child (path recorded in the PR description). They refine, and do not change, the decisions above.

## Review input folded in (2026-11-17)

An independent review of a parallel design raised five findings. Each was checked against the code.

1. Desktop and Vault recovery settings render on a server where nothing answers them (`settings/page.tsx`, routes mounted unconditionally in `server/index.ts`). Accepted. This PR gates both sections on `PDPP_MANAGED_DESKTOP_HOST`. Remote access stays visible.
2. `decide_console_navigation` opens the system browser for any https navigation with no gesture (`unified.rs`). Accepted. While attached the desktop asks for a native confirmation naming the target origin. Local mode is unchanged. The webview gives no gesture signal, so the confirm replaces a click check.
3. Identity before credentials. Accepted, and it corrects Decision 5. Built (see Decision 5).
4. Cookies are keyed by host, not port, so a forwarded remote and the local console collide. Accepted. Disconnect, an expired pairing and the switch delete the remote session cookie from the webview store, and the walkthrough attaches, disconnects and checks that the local console is signed in as local.
5. Stale comments claiming no IPC bridge. Not changed. `capabilities/console.json` grants the console window no `remote` URLs, so by Tauri 2 rules IPC is refused from an external origin whatever the injected global is. The walkthrough checks this by calling `window.__TAURI__.core.invoke` from the attached console. Comment wording is not part of this PR.

## Test profile build

A build made with `DATACONNECT_BUILD_PROFILE=<name>` (`[a-z0-9-]+`, checked at compile time) cannot touch the installed app. `profile.rs` runs first in `run()`: it moves `HOME` and the XDG base directories into `~/.dataconnect-profiles/<name>/home/` (0700), checks that `dirs` and the Tauri paths resolve inside it, and appends `.<name>` to every keychain service name. Tray, console and connect windows read `DataConnect (<name>)`. With no saved server, the connect window opens at launch. Unix only. No runtime flag turns it off.

    DATACONNECT_BUILD_PROFILE=attach-test \
    TAURI_CONFIG='{"identifier":"dev.dataconnect.attach-test","productName":"DataConnect Attach-test","bundle":{"resources":null}}' \
    npm run tauri build

The identifier keeps the single-instance lock apart from the installed app.
