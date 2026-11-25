# Other operational flows

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 13. Other operational flows

**Who starts it:** owner or connector. **Where:** tray “Show logs”; Settings → “Attach a desktop app”; Settings → “Vault recovery code”; server’s “Owner sessions”.

1. [V] Desktop logs: tray “Show logs” opens the OS log directory's `DataConnect.log` in the default viewer; if it fails, the error goes to the app log and status becomes Error. [src-tauri/src/unified.rs:801-805,2633-2645]
2. [V] Pair/disconnect desktop app: see §5. It is a separate user flow even when initiated by remote server owner.
3. [V] Export recovery keys: see §8. Recovery kit only restores keys.
4. [V] Owner revokes a device/browser or command-line bearer from Owner sessions. Success refreshes server-rendered list; failures show the returned message or “Could not update owner access.” [apps/console/src/app/(console)/settings/owner-sessions-setting.tsx:33-47,50-137]

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `settings`. **Combined isolated run:** `settings`: **pass**.

**What it verifies:** The capture reaches web-side owner and desktop-operational controls.

**Reaches:** Settings shows owner sessions, “Sign out” controls, “Attach a desktop app”, and “Export recovery kit”.

**Stops at:** It does not open OS logs, sign out another session, redeem a desktop pairing, or export the recovery kit.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: settings"
```

**Evidence:** `evidence/settings/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

Tray logging and native desktop actions require the Tauri app and operating system.
