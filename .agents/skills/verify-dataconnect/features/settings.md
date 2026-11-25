# Settings inventory

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 6. Settings inventory

**Who starts it:** owner; `/settings`. **Forms:** both, with desktop and vault recovery sections only when `PDPP_MANAGED_DESKTOP_HOST=1`. [apps/console/src/app/(console)/settings/page.tsx:24-110]

1. [V] **Developer mode:** checkbox “Enable developer connector surfaces”; “This reveals in-development connectors on Add source. It is stored in this browser and is off by default.” [apps/console/src/app/(console)/settings/developer-mode-setting.tsx:21-39]
2. [V] **Remote access:** full flow in §4. No persisted default beyond “Off” and “Only this computer can open DataConnect” until route exists. [apps/console/src/app/(console)/settings/remote-access-setting.tsx:121-128]
3. [V] **Owner password:** labels and defaults in §3. `PDPP_OWNER_PASSWORD` / `DATACONNECT_OWNER_PASSWORD` environment source cannot be changed in UI; message says to change environment then restart. [apps/console/src/app/(console)/settings/owner-password-setting.tsx:107-160]
4. [V] **Owner sessions:** live sessions and CLI bearer tokens; individual revoke, revoke other/all, revoke token. No limit or setting defaults. [apps/console/src/app/(console)/settings/owner-sessions-setting.tsx:50-137]
5. [V] **Attach a desktop app:** creates 10-minute pairing code, no persistent toggle. [apps/console/src/app/(console)/settings/desktop-pairing-setting.tsx:137-225]
6. [V] **Desktop** (desktop-managed host only): the three toggles and their exact help/defaults are in §2. While reads are pending it says “Reading the current desktop settings…”; if the reads fail, “The current desktop settings could not be read, so they are not shown. The controls below are unavailable rather than assumed off.” [apps/console/src/app/(console)/settings/desktop-settings-setting.tsx:150-255]
7. [V] **Vault recovery code** (desktop-managed host only): “Export a printable code that can restore access to your Personal Server vault if your system keychain ever loses its key.” Recovery key setting: “This code restores encryption keys only. Keep your database backup separately. Anyone who has both can read everything in your Personal Server vault.” Button “Export recovery kit”; resulting “Copy kit”/“Copied” or “Could not copy automatically. Select the kit above and copy it manually.” [apps/console/src/app/(console)/settings/page.tsx:94-107; apps/console/src/app/(console)/settings/recovery-key-setting.tsx:60-104]
8. [V] **About:** Product, Version, Build, Protocol, Copyright; links “Docs”, “Source”, “Apache-2.0 license”, “Third-party notices”, “Support”. [apps/console/src/app/(console)/settings/about-section.tsx:20-67]

There is no separate Settings appearance/language/update page in this route. Theme control is in the console shell (see §20); app version is displayed in About, and no update action appears in this Settings inventory.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `settings`. **Combined isolated run:** `settings`: **pass**.

**What it verifies:** The capture includes Developer mode, Remote access, Owner password, Owner sessions, desktop pairing, desktop settings, recovery code, and About.

**Reaches:** The signed-in `/settings` route renders at desktop and phone widths with its Settings heading and sections.

**Stops at:** It does not submit changes or verify native desktop settings.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: settings"
```

**Evidence:** `evidence/settings/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The browser view shows desktop-only sections but cannot prove Tauri integration.
