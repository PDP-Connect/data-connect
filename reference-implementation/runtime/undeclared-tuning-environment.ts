// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Transitional tuning declarations for first-party connectors whose pinned
 * manifest does not yet declare `runtime_requirements.tuning_environment`.
 *
 * These keys were static platform keys that reached every connector child.
 * They now reach only the connector that owns them, through the same
 * declaration path a manifest uses. An entry is used only while the manifest
 * of that connector has no `tuning_environment` field; a declaring manifest
 * always wins.
 *
 * Delete an entry when the vendored `@pdpp/polyfill-connectors` pin declares
 * it. `test/undeclared-tuning-environment.test.ts` fails when a pinned
 * manifest and this table both declare the same connector.
 *
 * Keys are canonical connector keys (see `server/connector-key.ts`).
 */
export const UNDECLARED_TUNING_ENVIRONMENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amazon: ["PDPP_AMAZON_YEARS", "PDPP_AMAZON_SKIP_DETAIL"],
  "apple-photos": ["PDPP_APPLE_PHOTOS_MAX_PHOTO_BYTES"],
  chatgpt: [
    "PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS",
    "PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER",
    "PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN",
    "PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS",
    "PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN",
    "PDPP_CHATGPT_PACING_BURST_TOLERANCE_MS",
    "PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS",
    "PDPP_CHATGPT_PACING_MAX_INTERVAL_MS",
    "PDPP_CHATGPT_PACING_MIN_INTERVAL_MS",
    "PDPP_CHATGPT_PACING_RECOVERY_GAIN",
    "PDPP_CHATGPT_RETRY_BUDGET_CAPACITY",
    "PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS",
    "PDPP_CHATGPT_CIRCUIT_BREAKER",
    "PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS",
    "PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS",
  ],
  codex: ["PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS"],
  gmail: [
    "PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES",
    "PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS",
    "PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_BYTES",
    "PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS",
    "PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES",
    "PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS",
    "PDPP_GMAIL_MAX_ATTACHMENT_BYTES",
  ],
  "google-takeout": ["PDPP_GOOGLE_TAKEOUT_MAX_PHOTO_BYTES"],
  imessage: ["PDPP_IMESSAGE_MAX_ATTACHMENT_BYTES"],
});
