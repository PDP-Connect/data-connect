# Use from a phone

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 11. Use from a phone

**Who starts it:** owner with a phone browser or AI app. **Where:** public address, `/owner/login`, `/settings`. **Forms:** server console via browser; phone is not the desktop app.

1. [V] Turn on public remote access in Settings on the computer/server; use an address reachable from the phone. Local-only status says “Only this computer can open DataConnect.” [apps/console/src/app/(console)/settings/remote-access-setting.tsx:121-128]
2. [V] Open the public address in phone browser; if owner auth is enabled, `/` redirects to `/owner/login`. Enter Owner password. The server page is server-rendered and responsive plain HTML/CSS. [deploy/docker/README.md:216-222; reference-implementation/server/owner-auth.ts:282-312]
3. [V] After sign-in, use the console routes; shell has mobile drawer support in shared `@pdpp/operator-ui` component and responsive layout, and data views include mobile-specific breakpoints. This is responsive web, not a separately packaged phone app. [reference-implementation/vendor/operator-ui/src/components/mobile-drawer.tsx:1 and test; `apps/console/src/app/(console)/components/shell.tsx:1`]
4. [I] Phone can be separately authorized in browser session list. Desktop pairing is for desktop app connecting to existing server; no phone pairing code flow exists. Owner can use password on phone, then revoke that session in Settings → Owner sessions. [apps/console/src/app/(console)/settings/owner-sessions-setting.tsx:50-137; docs/design/desktop-remote-attach.md:36-77]

**Rough edges:** remote address must already work from the internet; local LAN/Tailscale private paths are not usable by ChatGPT. The server UI is English. Phone-specific supported route list is not declared; responsive behavior is component/page implementation, not a formal mobile feature matrix.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `phone-use`. **Combined isolated run:** `phone-use`: **pass**.

**What it verifies:** The same responsive route is captured at 1440×1000 and 390×844.

**Reaches:** The Sources page renders at 390×844 and keeps “Sources” visible.

**Stops at:** This is a phone-sized browser viewport on loopback, not a physical phone or public server address.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: phone-use"
```

**Evidence:** `evidence/phone-use/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The capture does not test mobile OS notifications, remote DNS, TLS, or network reachability from another device.
