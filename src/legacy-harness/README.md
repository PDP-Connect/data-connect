# Legacy UI harness

The legacy UI harness renders the old React pages in a browser with typed
fixture state and mocked Tauri calls. Use it for visual and copy reference
while the legacy pages remain in `src/pages`.

## Run it

```bash
npm run legacy:ui
```

The command opens `legacy.html`, whose index links to each declared fixture
route.

## Fixture states

- `home-empty`: Home with no imports or connected sources.
- `home-connected`: Home with connected GitHub, ChatGPT, and Spotify sources and
  completed imports.
- `home-running`: Home with an active ChatGPT import, progress, and cancel
  affordances.
- `home-error`: Home with a failed GitHub import and an expired-authorization
  message.
- `home-sources`: Home's available-source tiers, connector-required rows, and
  coming-soon rows.
- `home-credentials`: Home's GitHub token and ChatGPT static-secret prompts.
- `install-panel`: Connector install and update rows.
- `import-history`: Active, successful, partial, failed, and stopped imports.
- `settings-credentials`: Stored browser-session rows and clear actions.
- `settings`, `connect`, `grant`, `timeline`, `source`, `personal-server`,
  `server-repairs`, `data-apps`, and `docs`: the corresponding legacy pages
  with baseline fixture state.

Manual upload has no legacy `src/pages` route, so the harness does not invent
one. The current manual-upload flow belongs to the console.

This harness is the reference for lifting UI/copy before the legacy pages are
deleted.
