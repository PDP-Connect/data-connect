# DataConnect

DataConnect is a local-first desktop application for collecting data from
online services and keeping the resulting data on your computer.

## Status

DataConnect is in active development. Use the
[Releases page](https://github.com/PDP-Connect/data-connect/releases) for
binary downloads when a release is available. Release artifacts are manual
installs. This build does not include an in-app auto-updater.

Public code signing is not available yet. Some macOS artifacts do not have a
signature. For an unsigned macOS build, run this command after installation:

```bash
xattr -cr /Applications/DataConnect.app
```

## What DataConnect does now

DataConnect writes collected data to local disk by default. Local collection
does not require a Vana account or a Vana sign-in.

Every installer bundles and runs a local Personal Server. It gives the desktop
app loopback-only access to imported and exported data. It also enables local
PDPP and MCP integrations. Remote registration and tunneling stay disabled
unless you configure service endpoints.

## Installation

Download the latest release from [Releases](../../releases).

### macOS

Install the DMG. If macOS blocks an unsigned build, run the `xattr` command in
the Status section and open the app again.

### Windows

Run the NSIS installer and follow the prompts.

### Linux

Use the `.deb` or `.AppImage` package.

## Build from source

Use this path if a binary is not available for your platform.

### Requirements

- Node.js 22 or 23.
- Rust stable and the Tauri build prerequisites for your operating system.
- Internet access during setup to install dependencies and resolve bundled
  connectors when they are absent.

### Run the development application

```bash
git clone https://github.com/PDP-Connect/data-connect.git
cd data-connect
npm install
npm run tauri:dev
```

`npm run tauri:dev` builds required local helper programs when needed. It also
resolves the bundled connectors from the signed connector index when they are
not already present.

### Create a package

```bash
npm run tauri:build
```

The command builds the frontend, the Personal Server, and the Playwright
runner. It creates Linux and macOS packages from a local checkout. Release CI
also builds the Windows NSIS installer.

Treat local build output as a development build. Do not treat it as a signed
public release.

## Browser Requirements

DataConnect uses browser automation for legacy connectors and for browser-based
PDPP collection profiles.

1. If you installed Chrome or Edge, DataConnect can use that browser.
2. If no supported system browser is found, DataConnect can use the Chromium
   build bundled with the installer.
3. For local builds without bundled Chromium, DataConnect provisions Chromium at
   runtime when needed.

DataConnect stores the downloaded browser in `~/.dataconnect/browsers/`. It
persists across app updates.

## Data sources

### GitHub PDPP Collection Profile

GitHub is a PDPP-native collection path. DataConnect prefers this path when the
GitHub PDPP connector is available. It collects GitHub profile, repositories,
stars, issues, pull requests, and gists through the PDPP Collection Profile
protocol.

To collect GitHub data:

1. Select **GitHub** on the Home page.
2. Enter a GitHub personal access token when DataConnect requests one.
3. Give the token the GitHub permissions needed for the data that you want to
   collect.
4. Select **Start import**.

DataConnect uses the token for that import only. The application does not save
the token. Use a token that you can revoke in GitHub if you no longer want to
use it.

### ChatGPT PDPP Collection Profile

ChatGPT is also available as a PDPP Collection Profile. It uses a browser
session to collect conversations, messages, memories, custom GPTs, custom
instructions, and shared conversations.

To collect ChatGPT data:

1. Select **ChatGPT** on the Home page.
2. Enter your ChatGPT sign-in details when DataConnect requests them.
3. Complete any browser sign-in or verification step.
4. Select **Start import**.

### Legacy browser connectors

DataConnect keeps its Playwright-based legacy connectors. They automate export
flows in a browser and write exports to local disk. The bundled legacy
connectors currently cover ChatGPT, Claude, GitHub, H-E-B, Instagram,
Instagram Ads, LinkedIn, Oura, Shop, Spotify, Whole Foods Market, and YouTube.

These connectors depend on the website and export process of each service. A
service can change that process without notice. A connector can therefore fail
or collect less data than expected.

The [PDP-Connect Data Connectors repository](https://github.com/PDP-Connect/data-connectors)
contains the connector artifacts and their signed index.

## Use Timeline locally

Timeline gives a chronological view of records from connected sources. The
current Timeline reads verified GitHub records from your local Personal Server.

1. Collect GitHub data with the GitHub PDPP Collection Profile.
2. Open **Apps > Timeline**.
3. Select **Review local Timeline access**.
4. Review the requested GitHub streams, access mode, retention, and expiry.
5. Select **Approve local Timeline access**.
6. View the Timeline.

The approval applies only to the local Personal Server on that device.
Timeline access expires after its issued lifetime, which is eight hours by
default.

To stop Timeline access, select **Revoke Timeline access** in Timeline. The
app revokes the local approval and returns you to the consent screen.

## Connector management

Connector versions use two pinned files: `connectors/connector-dependencies.json`
and `connectors/lock.json`.

```bash
npm run connectors:resolve
npm run connectors:check
```

`connectors:resolve` resolves the pinned versions from the signed connector
index and updates the bundled connector tree. `connectors:check` verifies the
lockfile and bundled connector tree without changing them.

## Releasing

Use the release script to create releases:

```bash
npm run release:github -- --show-versions
npm run release:github -- --version X.Y.Z --dry-run
npm run release:github -- --version X.Y.Z
```

If AI helped with the release commit, run `npm run release:github -- --version X.Y.Z --assisted-by-ai`.

Do not create releases manually with `gh release create` or the GitHub UI. The
CI workflow checks that `tauri.conf.json` matches the release tag.

Release artifacts are manual installs: macOS DMGs, Linux `.deb` and AppImage
files, and Windows NSIS installers. macOS artifacts do not have signatures
unless CI has the optional Apple signing secrets. Signed builds do not have
notarization.

The workflow can also run without uploading artifacts to validate all platform
build legs.

## Not supported yet

- Public code signing or notarization.
- A cloud account or remote service as a requirement for local collection.
- Timeline data from sources other than verified GitHub PDPP records.
- A guarantee that every legacy connector works with every account, browser, or
  service change.
- Automatic updates.

## License

DataConnect uses the Apache License 2.0. See [LICENSE](LICENSE) for details.
This software is open-source utility software. It is not a managed or hosted
service. See [LEGAL.md](LEGAL.md) for legal disclaimers and responsibility
information.
