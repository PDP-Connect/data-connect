// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const SETTING_FILE = `${HERE}remote-access-setting.tsx`
const ACTIONS_FILE = `${HERE}remote-access-actions.ts`
const WINDOW_FILE = `${HERE}../../../../../../public/owner-password.html`
const OWNER_CREDENTIAL_RUST_FILE = `${HERE}../../../../../../src-tauri/src/owner_credential.rs`
const UNIFIED_RUST_FILE = `${HERE}../../../../../../src-tauri/src/unified.rs`

test("remote access opens the native owner-password window and retries the pending save", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /requestOwnerPasswordWindowAction/)
  assert.match(setting, /result\.code === "owner_password_required"/)
  assert.match(setting, /continueAfterOwnerPassword/)
  assert.match(
    setting,
    /saveRemoteAccessConfig\(nextConfig, providerCredential\)/
  )
  assert.match(setting, /remoteConfigSaved = true/)
  assert.match(setting, /ownerPasswordSet && !remoteConfigSaved/)
  assert.match(setting, /restartAfterOwnerPasswordSet\(\)/)
})

test("remote-access first setup opens the desktop owner-password window without reauth", async () => {
  const actions = await readFile(ACTIONS_FILE, "utf8")

  assert.match(actions, /ownerPasswordOwnerSet/)
  assert.match(actions, /requestOwnerPasswordWindow/)
  assert.match(actions, /purpose: "initial_setup"/)
  assert.match(actions, /Use Settings to change the existing owner password/)
  assert.match(actions, /PDPP_MANAGED_DESKTOP_HOST/)
  assert.match(actions, /requestOwnerPasswordStackRestart/)
})

test("the migration banner can set the password and request restart for existing remote installs", async () => {
  const setting = await readFile(SETTING_FILE, "utf8")

  assert.match(setting, /setOwnerPasswordForMigration/)
  assert.match(setting, /Set owner password/)
  assert.match(setting, /showOwnerPasswordMigrationBanner/)
})

test("native password window uses the app-origin Tauri command", async () => {
  const html = await readFile(WINDOW_FILE, "utf8")

  assert.match(html, /window\.__TAURI__/)
  assert.match(html, /set_desktop_owner_password/)
  assert.match(html, /Array\.from\(password\)\.length < 15/)
})

test("native password command consumes native authority before saving", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")
  const command = rust.slice(
    rust.indexOf("pub(crate) async fn set_desktop_owner_password")
  )

  assert.match(rust, /static OWNER_REAUTH_GRANTS/)
  assert.match(rust, /owner_reauth_grants\(\)/)
  assert.match(
    command,
    /consume_owner_password_window_authority\(&app, window_request_id\)\?/
  )
  assert.match(command, /save_owner_credential\(&app, &password\)\?/)
  assert.doesNotMatch(command, /state\.grant_id/)
  assert.ok(
    command.indexOf(
      "consume_owner_password_window_authority(&app, window_request_id)?"
    ) < command.indexOf("save_owner_credential(&app, &password)?"),
    "native password save must not happen before the reauth grant is consumed"
  )
})

test("native OS reauth waits asynchronously and late callbacks cannot mint grants", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")

  assert.match(rust, /async fn owner_os_reauthenticate/)
  assert.match(rust, /tokio::sync::oneshot/)
  assert.match(rust, /tokio::time::timeout\(remaining, rx\)/)
  assert.doesNotMatch(rust, /recv_timeout/)
  assert.doesNotMatch(rust, /std::sync::mpsc/)
  assert.match(rust, /owner_os_reauthenticate\(deadline_unix_ms\)\.await/)
  assert.ok(
    rust.indexOf("tokio::time::timeout(remaining, rx)") <
      rust.indexOf('Ok("authenticated")'),
    "Rust must only report authentication after the awaited callback wins the timeout race"
  )
})

test("native grants are opaque purpose-bound tokens and Linux skipped auth cannot mint a write grant", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")

  assert.match(rust, /HashMap<String, OwnerReauthGrant>/)
  assert.match(rust, /uuid::Uuid::new_v4\(\)\.to_string\(\)/)
  assert.match(rust, /purpose: "change"\.to_string\(\)/)
  assert.match(rust, /window_request_id: None/)
  assert.match(rust, /grant\.window_request_id = Some\(request_id\)/)
  assert.match(rust, /status == "authenticated"/)
  assert.match(rust, /Ok\("skipped_linux_polkit_unverified"\)/)
  assert.ok(
    rust.indexOf('if status == "authenticated"') <
      rust.indexOf("let grant_id = uuid::Uuid::new_v4().to_string()"),
    "write grants must be minted only for authenticated OS reauth results"
  )
})

test("native password window permits first setup without grant but rejects later setup and requires grant for change", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")

  assert.match(rust, /Some\("initial_setup"\)/)
  assert.match(rust, /owner_password_owner_set_marker_exists\(app\)\?/)
  assert.match(rust, /Some\("recovery"\)/)
  assert.match(rust, /Some\("change"\)/)
  assert.match(rust, /grant\.purpose != "change"/)
  assert.match(rust, /grant\.window_request_id != Some\(request_id\)/)
})

test("desktop recovery imports v2 kits before startup and treats v1 kits as lost credential-key recovery", async () => {
  const rust = await readFile(UNIFIED_RUST_FILE, "utf8")
  const command = rust.slice(
    rust.indexOf("pub(crate) async fn import_database_encryption_recovery_code")
  )

  assert.match(rust, /decode_recovery_kit_for_import/)
  assert.match(rust, /crate::recovery_code::decode_v2\(code\)/)
  assert.match(rust, /crate::recovery_code::decode\(code\)/)
  assert.match(rust, /LegacyV1KitMissingCredentialKey/)
  assert.doesNotMatch(rust, /RecoveredFromV2Kit/)
  assert.match(command, /clear_recovery_credential_state\(&app\)\?/)
  assert.match(command, /if created_v1_recovery_marker/)
  assert.match(command, /recovery_attempt_failed_before_server_credential_transition/)
  assert.match(command, /credential_encryption_key_missing_for_sealed_credentials/)
  const loadedSecretsArm = command.slice(
    command.indexOf("Ok(secrets) =>"),
    command.indexOf("Err(DatabaseKeyError::Missing(_))")
  )
  assert.match(loadedSecretsArm, /clear_recovery_credential_state\(&app\)\?/)
  const existingKeyArm = command.slice(
    command.indexOf("Ok(existing) =>"),
    command.indexOf("Err(error) if credential_encryption_key_missing_for_sealed_credentials")
  )
  assert.match(existingKeyArm, /clear_recovery_credential_state\(&app\)\?/)
  assert.match(command, /let _ = clear_recovery_credential_state\(&app\)/)
  assert.match(command, /save_credential_encryption_key\(&app, credential_key\)/)
  assert.match(command, /request_owner_password_window_for_recovery\(&app\)\?/)
  assert.match(rust, /revoke_existing_sessions: bool/)
  assert.match(rust, /PDPP_RECOVERY_REVOKE_OWNER_SESSIONS/)
  assert.match(await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8"), /owner-password-recovery-window-request\.json/)
  assert.ok(
    command.indexOf("mark_recovery_credential_state(") <
      command.indexOf("start_managed_stack("),
    "legacy v1 recovery must record lost credential-key state before the managed stack can decrypt pending credentials or schedule connectors"
  )
  assert.ok(
    command.indexOf("request_owner_password_window_for_recovery(&app)?") <
      command.indexOf("finish_bootstrap("),
    "recovery must queue Set your password before opening the recovered console"
  )
})

test("v1 recovery keeps the lost credential-key marker when server transition startup fails", async () => {
  const rust = await readFile(UNIFIED_RUST_FILE, "utf8")
  const helper = rust.slice(
    rust.indexOf("fn recovery_attempt_failed_before_server_credential_transition"),
    rust.indexOf("/// Recovery-window command")
  )
  const command = rust.slice(
    rust.indexOf("Err(error) => {", rust.indexOf("let (ri_origin, console_url) = match result")),
    rust.indexOf("teardown_managed_on_error(&app, true, StopReason::VaultKeyRejected)", rust.indexOf("let (ri_origin, console_url) = match result"))
  )

  assert.match(helper, /Could not open the encrypted SQLite vault/)
  assert.match(helper, /The SQLite vault at /)
  assert.ok(
    command.indexOf("recovery_attempt_failed_before_server_credential_transition(&error)") <
      command.indexOf("let _ = clear_recovery_credential_state(&app)"),
    "v1 recovery must only clear its marker for a proven database-key failure before server credential transition"
  )
})

test("recovery startup revokes existing owner sessions before scheduler startup and console exposure", async () => {
  const rust = await readFile(UNIFIED_RUST_FILE, "utf8")
  const server = await readFile(`${HERE}../../../../../../reference-implementation/server/index.ts`, "utf8")
  const recoveryStart = rust.slice(
    rust.indexOf("pub(crate) async fn import_database_encryption_recovery_code"),
    rust.indexOf("let result = match attempt")
  )
  const finish = rust.slice(
    rust.indexOf("async fn finish_bootstrap"),
    rust.indexOf("async fn revoke_other_owner_sessions_after_recovery")
  )

  assert.match(recoveryStart, /start_managed_stack\([\s\S]*None,[\s\S]*true,/)
  assert.match(server, /RECOVERY_REVOKE_OWNER_SESSIONS_ENV/)
  assert.match(server, /revokeAllSessions/)
  assert.match(server, /listOwnerBearers/)
  assert.match(server, /revokeOwnerBearer/)
  assert.match(server, /RECOVERY_OWNER_SESSION_RESET_FILE/)
  assert.match(server, /renameSync\(resetPath, `\$\{resetPath\}\.applied`\)/)
  assert.ok(
    server.indexOf("await applyRecoveryOwnerSessionReset") < server.indexOf("const asServer = await asApp.listen"),
    "recovery must revoke old owner sessions before the AS listener starts"
  )
  assert.ok(
    server.indexOf("await applyRecoveryOwnerSessionReset") < server.indexOf("const rsServer = await rsApp.listen"),
    "recovery must revoke old owner sessions before the RS listener starts"
  )
  assert.ok(
    server.indexOf("await applyRecoveryOwnerSessionReset") < server.indexOf("await schedulerManager.start()"),
    "recovery must revoke old owner sessions before scheduler startup"
  )
  assert.ok(
    server.indexOf('logger.info("database initialized")') < server.indexOf("await applyRecoveryOwnerSessionReset"),
    "recovery session reset must run after DB initialization"
  )
  assert.ok(
    recoveryStart.indexOf("start_managed_stack(") >= 0,
    "recovery must start the managed stack through the recovery startup path"
  )
  assert.doesNotMatch(finish, /revoke_other_owner_sessions_after_recovery/)
})

test("server applies and consumes v1 lost credential-key state before scheduler startup", async () => {
  const server = await readFile(`${HERE}../../../../../../reference-implementation/server/index.ts`, "utf8")
  const helper = server.slice(
    server.indexOf("async function applyCredentialKeyLostRecoveryState"),
    server.indexOf("function createRequestAcquisitionBatchStore")
  )

  assert.match(server, /readCredentialRecoveryStateMarker/)
  assert.match(server, /markActiveRejectedForLostCredentialKey/)
  assert.match(helper, /renameSync\(marker\.path, marker\.appliedPath\)/)
  assert.match(helper, /Credential recovery state could not be consumed/)
  assert.ok(
    helper.indexOf("markActiveRejectedForLostCredentialKey") < helper.indexOf("renameSync(marker.path, marker.appliedPath)"),
    "lost credential-key marker must be consumed only after the row transition succeeds"
  )
  assert.ok(
    server.indexOf("await applyCredentialKeyLostRecoveryState") <
      server.indexOf("await schedulerManager.start()"),
    "lost credential-key recovery must reject active sealed credentials before schedulerManager.start"
  )
  assert.ok(
    server.indexOf('logger.info("database initialized")') <
      server.indexOf("await applyCredentialKeyLostRecoveryState"),
    "lost credential-key recovery must run after DB initialization"
  )
})

test("server validates the v1 lost credential-key marker and fails closed on unsupported state", async () => {
  const server = await readFile(`${HERE}../../../../../../reference-implementation/server/index.ts`, "utf8")
  const parser = server.slice(
    server.indexOf("function readCredentialRecoveryStateMarker"),
    server.indexOf("async function applyCredentialKeyLostRecoveryState")
  )

  assert.match(parser, /state\.version !== 1/)
  assert.match(parser, /state\.cause !== CREDENTIAL_KEY_LOST_CAUSE/)
  assert.match(parser, /Credential recovery state is malformed/)
  assert.match(parser, /Credential recovery state version is unsupported/)
  assert.match(parser, /Credential recovery state cause is unsupported/)
})

test("native recovery password authority is consumed only in the dedicated recovery request file", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")
  const consume = rust.slice(
    rust.indexOf("fn consume_owner_password_window_authority"),
    rust.indexOf("fn complete_owner_password_window_request")
  )

  assert.match(consume, /owner_password_recovery_window_request_path/)
  assert.match(consume, /is_recovery_request/)
  assert.match(consume, /save_owner_password_request_state\(&recovery_path, &state, "owner-password recovery request"\)/)
  assert.ok(
    consume.indexOf("if is_recovery_request") < consume.indexOf("owner_password_window_request_file_path"),
    "recovery authority consumption must not write the ordinary numbered request file"
  )
})

test("native recovery password request uses a Rust-owned file and the watcher opens it", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")
  const helper = rust.slice(
    rust.indexOf("pub(crate) fn request_owner_password_window_for_recovery"),
    rust.indexOf("pub(crate) fn complete_owner_password_stack_restart_request")
  )
  const watcher = rust.slice(
    rust.indexOf("pub(crate) fn spawn_owner_password_window_watcher"),
    rust.indexOf("pub(crate) fn spawn_owner_password_stack_restart_watcher")
  )

  assert.match(helper, /owner_password_recovery_window_request_path/)
  assert.doesNotMatch(helper, /owner_password_window_request_path/)
  assert.doesNotMatch(helper, /owner_password_window_request_file_path/)
  assert.match(watcher, /owner_password_recovery_window_request_path/)
  assert.match(watcher, /purpose\.as_deref\(\) == Some\("recovery"\)/)
  assert.match(watcher, /open_owner_password_window\(&app\)/)
})

test("native request lifecycle uses per-request files and does not rewrite terminal reauth results", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")

  assert.match(rust, /OWNER_OS_REAUTH_REQUEST_PREFIX/)
  assert.match(rust, /OWNER_PASSWORD_WINDOW_REQUEST_PREFIX/)
  assert.match(rust, /request_ids_with_prefix/)
  assert.match(rust, /owner_os_reauth_result_exists\(&app, request_id\)/)
  assert.match(rust, /if owner_os_reauth_result_exists\(app, request_id\)\?/)
})

test("native window requests become opened without mutating the TS allocation index", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")
  const watcher = rust.slice(
    rust.indexOf("pub(crate) fn spawn_owner_password_window_watcher"),
    rust.indexOf("pub(crate) fn spawn_owner_password_stack_restart_watcher")
  )

  assert.match(watcher, /state\.status\.as_deref\(\) == Some\("opened"\)/)
  assert.match(watcher, /state\.status = Some\("opened"\.to_string\(\)\)/)
  assert.doesNotMatch(watcher, /owner_password_window_request_path\(&app\)/)
})

test("native OS reauth refreshes time before each prompt so queued requests cannot start after deadline", async () => {
  const rust = await readFile(OWNER_CREDENTIAL_RUST_FILE, "utf8")
  const watcher = rust.slice(
    rust.indexOf("pub(crate) fn spawn_owner_os_reauth_watcher"),
    rust.indexOf('#[cfg(any(target_os = "macos", target_os = "windows"))]')
  )

  assert.match(watcher, /fresh_now_unix_ms = match unix_time_ms_now\(\)/)
  assert.match(watcher, /fresh_now_unix_ms >= deadline/)
  assert.ok(
    watcher.indexOf("fresh_now_unix_ms = match unix_time_ms_now()") <
      watcher.indexOf("owner_os_reauthenticate(deadline_unix_ms).await"),
    "deadline must be refreshed immediately before starting each native prompt"
  )
})
