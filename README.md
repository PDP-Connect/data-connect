# DataConnect

> DataConnect is being made local-first and vendor-neutral. The app runs and exports your data to disk with no sign-in and no external account. Vana is one optional storage and sync provider you can enable in Settings, not a bundled default. Some code paths, URLs, and package names still assume Vana; we are actively generalizing these as the project moves toward a neutral, provider-agnostic architecture.

Desktop app for exporting your data from various platforms.
<img width="2466" height="1372" alt="Screenshot 2026-02-24 at 8 10 08 PM" src="https://github.com/user-attachments/assets/c3d72ca7-866d-4629-8f24-51b782a820e8" />

## Installation

Download the latest release from [Releases](../../releases).

### macOS

macOS artifacts may be unsigned. For an unsigned build, run this after installing:

```bash
xattr -cr /Applications/DataConnect.app
```

Then open the app normally.

### Windows

Run the `.exe` installer and follow the prompts.

### Linux

Use the `.deb` or `.AppImage` package.

Every installer bundles and runs a local Personal Server. It gives the desktop app loopback-only access to imported and exported data, and it enables local PDPP and MCP integrations. Remote registration and tunneling stay disabled unless you explicitly configure service endpoints.

## Browser Requirements

DataConnect uses browser automation to export your data. Release installers include a compatible Chromium build. At runtime:

1. **If you have Chrome/Edge installed:** The app uses your existing browser (recommended)
2. **If no system browser is found:** The app uses the Chromium bundled with the installer
3. **For local builds without bundled Chromium:** The app downloads Chromium automatically when needed

The downloaded browser is stored in `~/.dataconnect/browsers/` and persists across app updates.

## Supported Platforms

DataConnect currently supports exporting data from ChatGPT, GitHub, Instagram, LinkedIn, Spotify,YouTube, and Shop (Shopify) — covering your conversations, social profiles, listening history, watch history, order history, and more.

For the latest available connectors, visit the [Data Connectors repository](https://github.com/vana-com/data-connectors).

## Development

### Prerequisites

- Node.js 20+
- Rust (latest stable)
- For Playwright connectors: `cd playwright-runner && npm install`

### Running locally

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# Copy .env file
cp .env.example .env
```

### Connector management

Connector scripts live upstream in [`vana-com/data-connectors`](https://github.com/vana-com/data-connectors). This repo consumes them as pinned dependencies.

#### Updating connectors

```bash
npm run connectors:resolve
# Review the diff in connectors/, commit, push.
```

This fetches the latest matching versions from the signed data-connectors index, verifies checksums, and writes them to `connectors/`. Version constraints are declared in `connectors/connector-dependencies.json`.

If you only want to verify the lockfile and bundled connector tree without mutating them, run `npm run connectors:check`.

#### How it works at runtime

- `tauri dev` runs `ensure-connectors.js`, which restores missing bundled connectors from `~/.dataconnect/connectors/` first and then resolves them from the signed connector index if needed.
- The Rust backend loads connectors from active installs in `~/.dataconnect/connectors-store/` via `connectors-active.json`, then legacy `~/.dataconnect/connectors/`, then bundled `connectors/`.
- The `playwright-runner` executes connector scripts with a local Chromium browser.

### Agent config files

This repo keeps both `AGENTS.md` and `CLAUDE.md`: Claude Code auto‑loads `CLAUDE.md` but not `AGENTS.md`, and Cursor does the opposite. Keep them aligned.

### Agent skills sync

Skills are stored in `.agents/skills` (source of truth). Cursor reads them via per-skill symlinks in `.cursor/skills`. The sync script rebuilds those symlinks so any manually created skills show up in Cursor.

```bash
# One-off sync (default is .cursor/skills)
npm run skills:sync

# Sync to Claude instead
npm run skills:sync -- --target=claude

# Auto-sync on changes
npm run skills:watch
```

### Building for production

```bash
# Install the locked dependencies, then build helpers and the native bundle
npm ci
npm run tauri:build
```

Local installs and builds do not download Chromium as an npm lifecycle step. A local build bundles a compatible Playwright Chromium already present in its cache when available. Otherwise, the app uses a supported system browser or provisions Chromium at runtime. Release CI explicitly provisions Chromium and fails verification if the browser executable is absent from an installer.

The built app will be in `src-tauri/target/release/bundle/`.

### Releasing

Releases are created via the release script, which bumps the version in `tauri.conf.json`, commits, pushes, and creates a GitHub release that triggers CI builds across macOS, Linux, and Windows.

```bash
# Check current and suggested versions
npm run release:github -- --show-versions

# Dry run to preview what will happen
npm run release:github -- --version X.Y.Z --dry-run

# Create a new release
npm run release:github -- --version X.Y.Z
```

> **Do not** create releases manually via `gh release create` or the GitHub UI — the CI workflow will fail if `tauri.conf.json` version doesn't match the release tag.

Release artifacts are manual installs: macOS DMGs, Linux `.deb` and AppImage files, and Windows NSIS installers. This build does not include an in-app auto-updater. macOS artifacts are unsigned unless the optional `APPLE_BUILD_CERTIFICATE_BASE64`, `APPLE_BUILD_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` GitHub secrets are configured. Signed builds are not notarized.

The workflow can also be run manually without uploading artifacts (`workflow_dispatch` with `upload: false`) to validate all platform build legs.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DataConnect App                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   React UI  │  │ Tauri/Rust  │  │ Playwright      │  │
│  │  (Frontend) │◄─►│  (Backend)  │◄─►│ Runner          │  │
│  └─────────────┘  └─────────────┘  └────────┬────────┘  │
└────────────────────────────────────────────┬┼───────────┘
                                             ││
                    ┌────────────────────────┘│
                    │                         │
              ┌─────▼─────┐           ┌───────▼───────┐
              │  System   │           │  Downloaded   │
              │  Chrome   │    OR     │   Chromium    │
              └───────────┘           └───────────────┘
```

### Browser Selection Priority

1. **System Chrome** - `/Applications/Google Chrome.app` (macOS)
2. **System Edge** - Available on Windows
3. **Downloaded Chromium** - `~/.dataconnect/browsers/`
4. **Auto-download** - If nothing found, downloads Chromium on first run

## Connectors

Connectors are JavaScript files that automate data export. Located in the [Data Connectors repository](https://github.com/vana-com/data-connectors).

### Connector API (Playwright runtime)

```javascript
// Available in connector scripts:
page.goto(url) // Navigate to URL
page.evaluate(script) // Run JS in page context
page.sleep(ms) // Wait for milliseconds
page.setData(key, value) // Send data back to app
page.promptUser(message, checkFn) // Wait for user action
```

## License

This project is licensed under the Apache License 2.0. See the LICENSE file for details.
This software is provided as open-source utility software and is not a managed or hosted service.
See LEGAL.md for additional legal disclaimers and responsibility framing.
