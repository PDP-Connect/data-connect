# Use the live browser

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 3. Use the live browser

**Who starts:** Person starts browser setup/reconnect or follows “Open the streaming companion →” from a waiting run. **Where:** `/syncs/<runId>/stream`. On browser-session connect, page instructions say selecting “Connect account” opens a secure browser panel; after starting, Console navigates to a launch route and then the stream. **Both forms.** A public/reachable server is needed for remote use; provider account needed. V — `apps/console/src/app/(console)/connect/browser-session/[connectorId]/page.tsx:278-333`, `apps/console/src/app/(console)/syncs/[runId]/page.tsx:334-340`, `apps/console/src/app/(console)/syncs/[runId]/stream/page.tsx:186-279`.

1. Before it opens, browser-session page says: “How this works”; “Select Connect account below. PDPP opens a secure browser panel.”; “Sign in to [name] in that browser. PDPP stores the browser session state needed for this source.”; “Once login is detected, the browser closes and collection resumes automatically.” Repair mode says “Log in to [name] in the secure browser to restore collection. Your existing records and history are preserved.” It also says “Browser did not open? Try again, or return to Sources and retry from this source. If DataConnect cannot start the secure browser, it will show the reason before any data is changed.” V — `apps/console/src/app/(console)/connect/browser-session/[connectorId]/page.tsx:278-333`.
2. Launch state says “secure browser” and “Starting the browser session...” while it starts. Failure says “Browser session did not finish starting”, with “Try again”, “Open Syncs”, “Back to Sources”. If transport changed after run start, the message is “DataConnect may have started the browser run, but this page could not confirm it after the network changed. Open Syncs, or try again if no new run appears.” A recovery request attempts to find the already-started run before retrying. V — `apps/console/src/app/(console)/connect/browser-session/[connectorId]/launch/launch-panel.tsx:32-103,106-170`.
3. Stream route first reads the run timeline and status. If browser surface is starting: “Preparing the secure browser.” / “Keep this page open. Browser controls will appear automatically when the run needs your input.” If no surface yet: “Waiting for a browser surface” / “Keep this page open while the secure browser prepares. The page updates automatically when it is ready.” Both poll and update automatically. V — `apps/console/src/app/(console)/syncs/[runId]/stream/page.tsx:223-279,362-382,408-432`.
4. The running stream is a remote browser surface with pointer and keyboard input, a location label showing hostname and path, and expandable corner actions. “More [source] browser actions” discloses clipboard, copy, paste, and keyboard controls. Labels include “Open clipboard for [source] browser”, “Copy selected text from [source] browser”, “Open paste controls for [source] browser”, “Show keyboard for [source] browser” / “Tap to type in [source] browser”. Clipboard dialog includes “Paste from device”, “Send to browser”, “Copy browser selection”, “Copy to device”, “Clear”. Mobile has soft keyboard / “Tap to type” affordance. No editable address bar or app-provided back button is shown: navigation is performed in the provider page/browser surface. Keyboard, pointer, paste and clipboard are forwarded based on backend capability/policy. V — `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5378-5577,5626-5683`; `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5260-5365` (clipboard panel); `apps/console/src/app/(console)/syncs/[runId]/stream/neko-client.ts:1` and `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1` input handlers.
5. For a manual step, overlay message comes from the provider. It says: “When the browser page is logged in or the requested action is complete, press Continue collection. Hiding this panel only moves it out of the way; it does not resume the run.” Button: “Continue collection”. For OTP, “Submit code” or “I entered it in the browser”. Overlay can collapse to a button; hide/collapse is not completion. V — `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5817-5868`.
6. The X control is explicitly “End [source] browser session”. During pending manual action/OTP it opens “End the [source] browser session now?” and “The step in progress will be abandoned. To get the panel out of the way without ending the session, use ‘Hide instructions’ instead.” Actions “End browser session” / “Keep working”. The browser surfaces are torn down; ending is not a harmless close. V — `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5595-5620,5685-5726`.
7. After response, successful browser step says “[source] is back on it.” / “The browser step is complete. You can close this tab with your browser controls, or view run details.” If the run continues after one browser step, another page says “Browser step complete.” / “Collection is continuing in the background. You can close this page — it updates automatically if browser input is needed again.” If no action is currently waiting: “No browser action is waiting.” / “The run is still in progress. This page updates automatically when browser input is needed.” If secure slot stays full: “Secure browser slot unavailable.” / “No connector work started. Try again when a secure browser slot is available.” V — `apps/console/src/app/(console)/syncs/[runId]/stream/page.tsx:282-359,384-405`; `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:5916-5946`.

**Desktop vs remote:** The Console route and interaction controls are shared. Stream code can use a direct browser-surface/CDP backend or n.eko viewer; it routes touch/keyboard/clipboard based on backend capability. Desktop also registers a native browser-surface host through Tauri. A phone/other computer uses the remote web stream and can need the configured public/remote-access path. This branch has backend-specific control logic but no simple UI statement that tells the person which backend is active. V — `apps/console/src/app/(console)/syncs/[runId]/stream/stream-cdp-mobile-controls.ts:1`; `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx:1`; `src-tauri/src/commands/browser_surface_host.rs:1`; I — exact native-vs-remote selection by runtime.

**Rough edges:** (1) no visible address bar/back control from Console; provider page must expose navigation; (2) stream header includes internal “browser step”/“secure browser” terms; (3) location indicator tells domain/path but not why it is safe; (4) closing during interaction abandons step and requires a second confirmation; (5) desktop-native and remote backend choice is not explained to the person.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `live-browser`. **Combined isolated run:** `live-browser`: **pass**.

**What it verifies:** The journey opens the run’s `/stream` companion route using the seed run identifier.

**Reaches:** The captured seeded run companion page displays “spotify is back on it”.

**Stops at:** This is a completed-run page, not an active browser session. The Spotify fixture is not browser-bound, so its browser-session setup routes return 404.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: live-browser"
```

**Evidence:** `evidence/live-browser/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

Do not treat the completed interaction stream as proof that a live browser session can launch or collect.
