# Owner sign-in, first password, later sign-in, logout, and multiple devices

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 3. Owner sign-in, first password, later sign-in, logout, and multiple devices

**Who starts it:** owner or first-boot server operator. **Where:** desktop Settings; `/setup`; `/owner/login`; `/device`; Settings → Owner sessions. **Evidence:** V for the two login surfaces and Settings; the first-boot route text varies with hosted deployment. **Forms:** both.

1. [V] **New self-hosted server.** If no `PDPP_OWNER_PASSWORD` is set, startup logs a one-time setup token and says “Owner setup is required; claim this instance at /setup”. `/setup` is a plain HTML page headed “Set owner password” with fields “Setup token” and “New password (15 characters minimum)” and button “Claim this install”. On success it returns “Owner password set. You can now sign in.” Failures are plain text: “Too many setup attempts.”, “Setup is no longer available.”, “Invalid setup token.”, “Password must contain at least 15 characters.”, “That password is too common. Choose a longer or less predictable one.”, or “Unable to save the owner password.” [reference-implementation/server/index.ts:9020-9030; reference-implementation/server/owner-setup.ts:48-99; reference-implementation/server/owner-password-blocklist.ts:30; Docker README:80-91; Railway README:85-89]
2. [V] **New desktop password.** Settings → Remote access first shows “Step 1: Set a password” and “Once remote access is on, anyone with your address reaches the sign-in page. This password is the only thing stopping them, so choose one first.” Clicking “Set password” opens the native `Set owner password` window. It has heading “Set owner password”; warning “This password is the only way in.”; fields “New password” and “Confirm password”; “Show”/“Hide”; buttons “Suggest a password”, “Copy”, and “Save password and continue”; hint “At least 15 characters. Longer is safer.” It generates four hyphen-joined words, example `maple-orbit-canyon-velvet`. [apps/console/src/app/(console)/settings/remote-access-setting.tsx:998-1013; public/owner-password.html:98-154; public/passphrase/generate.js:6-43; public/passphrase/words.js:1]
3. [V] Native password window feedback: “Copied”; “At least 15 characters.”; “The passwords do not match.”; “This window cannot reach DataConnect. Restart the app and try again.”; “Could not set the owner password.”; copy failure “Copy did not work. Select the password and copy it yourself.”; save-in-progress “Saving...”. `public/passphrase/` contains the dialog/generator/word-list modules and declarations; it has no HTML page. The page is `public/owner-password.html`. [public/passphrase/dialog.js:26-89; public/passphrase/generate.js:46-55; public/passphrase/words.js:1]
4. [V] **Later browser sign-in.** `/owner/login` asks for “Owner password”, with lead “This password keeps other people from seeing your data or changing which apps can use it.” Button: “Sign in”. Wrong password says “Incorrect password.”; rate limit says “Too many sign-in attempts from this address. Try again in about <n> seconds.” If no password exists on a local development server, it says “Sign-in is not required right now”, “Device approvals are open locally. Consent approvals still arrive through pending request links.”, and offers “Open device approval UI”. [reference-implementation/server/owner-auth.ts:282-312,315-352,744-770,949] **No forgot-password email or self-service reset page exists.** For desktop, Settings → Owner password uses the OS keychain and can reveal it locally to sign in on another device; change opens native window. For server, password comes from `PDPP_OWNER_PASSWORD` or an app-managed verifier. [reference-implementation/README.md:142-156]
5. [V] **Change/sign out.** Non-desktop Settings password form labels “Current password”, “New password”, “Confirm new password”, “Change password”; instruction “Use at least 15 characters. Your current browser stays signed in; other sessions are ended.” Errors include “Use at least 15 characters for the new password.” and “The new passwords do not match.” Success: “Password changed. Other signed-in devices have been signed out.” [apps/console/src/app/(console)/settings/owner-password-setting.tsx:41-75,165-220] Desktop text says changing password signs out other browser sessions and CLI tokens and restarts server. [apps/console/src/app/(console)/settings/owner-password-setting.tsx:139-160]
6. [V] **Multiple devices and CLI sessions.** Owner sessions lists “Devices and browsers”, individual “Sign out”, optional “Sign out other devices”, “Sign out all devices”, and “Command-line access” with “Revoke token”. Signing out blocks the next request; no MFA or forgot-password path is shown. [apps/console/src/app/(console)/settings/page.tsx:75-84; apps/console/src/app/(console)/settings/owner-sessions-setting.tsx:50-137] `/owner/logout` clears the session; the signed-in landing has sign-out action (server docs). [reference-implementation/README.md:151-156,365-370]

**Rough edges:** app-owned password can be revealed only from the desktop’s local webview; the server-hosted `/owner/login` says only “Owner password”. The standalone password window uses native system colors and styles, not the console design system. Lost password recovery for hosted server is an operator/environment action, not an on-screen flow.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `owner-login-lifecycle`. **Combined isolated run:** `owner-login-lifecycle`: **pass**.

**What it verifies:** The isolated server signs out the browser session and returns the real server-rendered sign-in form.

**Reaches:** The journey starts on the signed-in owner page, clicks “Sign out”, then shows the “Owner password” field and “Sign in to DataConnect” heading.

**Stops at:** It does not create the first owner password, submit another password, test lockout, recover a password, or revoke other devices.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: owner-login-lifecycle"
```

**Evidence:** `evidence/owner-login-lifecycle/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The doctor authenticates before each journey. This journey then signs out inside its disposable browser context; no real session is involved.
