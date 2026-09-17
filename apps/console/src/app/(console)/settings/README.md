# Settings

## What this is

- Owns browser-local settings for optional Console surfaces.

## Files

- `page.tsx`: `/settings` route and page composition.
- `developer-mode-setting.tsx`: client-side developer-mode toggle.
- `developer-mode.invariants.test.ts`: persistence and surface-gating checks.

## Data flow

- The toggle writes `dataconnect_developer_mode` to browser local storage → the shared developer-mode store notifies client surfaces → `/sources/add` updates its visible controls.

## App integration

- Route: `/settings`
- Entry points: the RecordroomShell Workspace navigation group.
- Integration: gates developer connector sources and development connector visibility on `/sources/add`.
- This page is unrelated to grant flow and does not read or mutate Personal Server data.

## Behavior

- Developer mode is off by default.
- When enabled, the Add source page shows the developer connector sources panel and the development connector filter.

## Notes

- The setting is browser-local; it is not a Personal Server configuration.
