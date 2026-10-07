# Settings

## What this is

- Owns browser-local optional Console surfaces and the desktop remote-access
  posture.

## Files

- `page.tsx`: `/settings` route and page composition.
- `developer-mode-setting.tsx`: client-side developer-mode toggle.
- `developer-mode.invariants.test.ts`: persistence and surface-gating checks.
- `remote-access-setting.tsx`: desktop-only Off / My devices only / Public URL
  control and owner-password gate.
- `remote-access.ts`: origin validation, reachability fields, and browser-safe
  remote-access types.
- `remote-access.test.ts`: origin, privacy-badge, and password-gate oracles.

## Data flow

- The toggle writes `dataconnect_developer_mode` to browser local storage → the shared developer-mode store notifies client surfaces → `/sources/add` updates its visible controls.
- The remote-access setting reads and writes the native Tauri provider config;
  the native side persists the four `PDPP_*` reachability fields and restarts
  the managed loopback stack after a change.

## App integration

- Route: `/settings`
- Entry points: the RecordroomShell Workspace navigation group.
- Integration: gates developer connector sources and development connector visibility on `/sources/add`.
- This page is unrelated to grant flow. Remote access changes reachability
  configuration but does not read or mutate Personal Server data.

## Behavior

- Developer mode is off by default.
- When enabled, the Add source page shows the developer connector sources panel and the development connector filter.
- Remote access is Off by default. Public URL requires an HTTPS origin and an
  owner password in the same blocking flow.

## Notes

- Developer mode is browser-local. Remote access is a desktop configuration and
  is unavailable in a normal browser session.
