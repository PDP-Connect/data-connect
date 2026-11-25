# Back up, restore, move, encrypt, and delete data

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 8. Back up, restore, move, encrypt, and delete data

**Who starts it:** owner/operator. **Where:** Settings → Vault recovery code; storage volume or database tools; deployment docs. **Forms:** desktop and server.

1. [V] Desktop stores the encrypted SQLite vault at `<app-data-dir>/unified/pdpp.sqlite`; the OS-specific app-data path varies. Its encryption keys and owner password are kept in the OS keychain. Recovery kit exports a printable code that restores keys only; it does not include the database file. Back up both separately. [src-tauri/src/unified.rs:82-83,2787-2807,2827-2868; apps/console/src/app/(console)/settings/page.tsx:94-107; apps/console/src/app/(console)/settings/recovery-key-setting.tsx:9-20,62-64]
2. [V] Docker quickstart: back up the entire `pdpp_data` volume. It contains SQLite, setup state, browser profiles, connector artifacts, and encryption key. Production Compose needs three things backed up together: `pdpp-postgres-data` (records), `pdpp-data` (model files and first-boot state), and `.env` (secrets). The docs do not give a single backup command. [deploy/docker/README.md:224-235,146]
3. [I] To restore or move a server, restore the database/volume set and encryption key together, then restart the service. The recovery kit restores keys only; it does not include the DB. Exact restore commands depend on storage backend and are not documented as a one-button flow. **I:** a desktop move likewise needs local server data and the keychain/recovery kit; the app has no export/import wizard.
4. [V] The four-word password is the owner sign-in secret, not the data recovery code. There is no separate stored-data encryption passphrase prompt in these flows. The recovery kit restores vault encryption keys. Server connector credentials use `PDPP_CREDENTIAL_ENCRYPTION_KEY`; desktop keeps owner password and vault key material in the OS keychain. [reference-implementation/README.md:395-399; src-tauri/src/unified.rs:2827-2868; apps/console/src/app/(console)/settings/recovery-key-setting.tsx:60-104]
5. [V] Delete data by removing the storage and keys outside the app. Docker quickstart commands: `docker rm -f pdpp && docker volume rm pdpp_data`; production: `docker compose down --volumes`. Fly teardown uses `fly apps destroy "$APP"`, then lists and destroys the Postgres app; Railway says delete `core` and the Postgres plugin. Settings has no “Delete everything” control. [deploy/docker/README.md:281-285; deploy/flyio/README.md:213-226; deploy/railway/README.md:207-212]

**Rough edges:** no combined DB + keys backup; moving without the key can leave encrypted vault unavailable. Recovery kit is only available on managed desktop host. Full deletion has no confirmation flow/documented single command for all deployment modes.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `settings`. **Combined isolated run:** `settings`: **pass**.

**What it verifies:** The capture reaches the visible recovery-kit instructions in Settings.

**Reaches:** Settings shows “Vault recovery code”, “Export recovery kit”, and the text that the code restores encryption keys only.

**Stops at:** It does not export a recovery code, copy the host database/volume, restore a backup, move storage, or delete host data.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: settings"
```

**Evidence:** `evidence/settings/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

A recovery kit is not a database backup. The harness does not manipulate host storage or export recovery secrets.
