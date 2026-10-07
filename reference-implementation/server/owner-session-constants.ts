// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Crypto-free owner-session constants. Split out from owner-session.ts so
// edge-runtime consumers (e.g. apps/console/src/proxy.ts) can read the
// cookie name without pulling in "node:crypto", which does not exist on the
// edge runtime. owner-session.ts re-exports these for existing consumers.

export const OWNER_SESSION_COOKIE_NAME = "pdpp_owner_session";
export const OWNER_SESSION_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const OWNER_SESSION_DEFAULT_SUBJECT_ID = "owner_local";

export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
export const OWNER_AUTH_DEFAULT_SESSION_TTL_SECONDS = OWNER_SESSION_DEFAULT_TTL_SECONDS;
export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;
