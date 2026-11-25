# First launch, tray, autostart, closing, and second launch

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 2. First launch, tray, autostart, closing, and second launch

**Who starts it:** person or OS login task. **Where:** launch desktop executable; tray menu afterward. **Evidence:** Basecheck covers managed-server startup and first Overview. The following extensions are V. **Form:** desktop.

1. [V] App creates a tray icon before async bootstrap and starts watchers for remote-access configuration, autostart, origin verification, recovery export, owner-password window, OS reauthentication, and password-change server restart. It reaps stale child processes, then bootstraps managed server/console unless attach mode applies. While the console starts, the tray status is “Starting”; “Open in browser” is disabled. The desktop creates/navigates the console window only after the server sign-in and console readiness check pass. Each readiness attempt may take 45 seconds; retries can continue for up to 10 minutes before bootstrap fails. No separate loading-window copy is defined. [src-tauri/src/unified.rs:57,68,576-650,654-719,3211-3245,3297-3312]
2. [V] Tray menu in local mode: disabled scope row “This computer”; current status row (e.g. Starting/Ready/Error, label from `UnifiedStatus`); “Open DataConnect”; “Open in browser” (enabled only when Ready); “Connect to a server...” ; “Show logs”; “Quit”. [src-tauri/src/unified.rs:576-650] Attached mode replaces Connect with “Disconnect from <host>”; environment-override mode has no attach/detach item. [src-tauri/src/unified.rs:591-599]
3. [V] **Close versus quit.** `Keep running when the window is closed` is on by default. Closing hides the window; DataConnect and background connectors keep running. First close may show one OS notification: “DataConnect keeps running in the tray. Reopen it anytime from the tray icon, or quit from there.” [apps/console/src/app/(console)/settings/desktop-settings-setting.tsx:240-255; src-tauri/src/unified.rs:5052-5082,5105-5127] “Quit” exits the process; it is the menu action that stops background work. When already quitting, Quit is visible but disabled. [src-tauri/src/unified.rs:616-624]
4. [V] **Autostart and minimized launch.** Settings labels and help are “Launch at login” — “Start DataConnect automatically when you sign in to this computer. Off by default.”; “Start minimized” — “Keep the console window hidden at startup. DataConnect keeps running in the tray; open it from there. Off by default.”; and “Keep running when the window is closed” — “Closing the window hides it to the tray instead of quitting. DataConnect and its background connectors keep running; quit from the tray menu to stop them. On by default.” Autostart shows “Applying…” while the OS applies it. Start minimized hides only the initial console; an explicit tray Open always shows it. [apps/console/src/app/(console)/settings/desktop-settings-setting.tsx:175-255; src-tauri/src/unified.rs:679-686]
5. [V] **Second launch.** Single-instance behavior focuses/opens the existing desktop app rather than starting a second server; a saved attachment is loaded before bootstrap and remote session is checked. The route path may show attach again if a pairing is expired/revoked. [src-tauri/src/unified.rs:654-719; docs/design/desktop-remote-attach.md:46-53] **I for exact OS activation:** the code delegates the second-click handoff to Tauri's single-instance plugin.

**Rough edges:** tray items are native menu strings outside the React console, so redesigning console components does not change them. “Show logs” launches the file in the operating system; the app does not provide an in-app log viewer.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `settings`. **Combined isolated run:** `settings`: **pass**.

**What it verifies:** The capture reaches the web-rendered desktop-settings section.

**Reaches:** Settings shows Desktop startup controls, including “Launch at login”, “Start minimized”, and “Keep running when the window is closed”.

**Stops at:** The page says “Reading the current desktop settings…”; it does not launch Tauri, create a tray, close a window, or test autostart.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: settings"
```

**Evidence:** `evidence/settings/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The native lifecycle and tray are not available in this browser harness. A Settings screenshot is only the web-side control surface.
