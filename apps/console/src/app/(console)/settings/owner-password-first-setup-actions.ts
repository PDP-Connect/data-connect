"use server";
import {
  ownerPasswordOwnerSet,
  requestOwnerPasswordStackRestart,
  requestOwnerPasswordWindow,
} from "pdpp-reference-implementation/owner-password-owner-set";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { hasValidLocalOwnerCredentialRevealProofCookie } from "../lib/owner-credential-client.ts";

function actionMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Owner password operation failed.";
}
export async function requestOwnerPasswordWindowAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireDashboardAccess("/settings");
  if (process.env.PDPP_MANAGED_DESKTOP_HOST !== "1") {
    return {
      ok: false,
      message: "Open the DataConnect desktop app to set the owner password.",
    };
  }
  // The window opens on the owner's desktop; only the desktop's own webview
  // may ask for it, not a browser reaching the console over remote access.
  if (!(await hasValidLocalOwnerCredentialRevealProofCookie())) {
    return {
      ok: false,
      message: "Open Settings from the local desktop app to set the owner password.",
    };
  }
  try {
    if (await ownerPasswordOwnerSet(process.env.PDPP_DATA_DIR || "data")) {
      return {
        ok: false,
        message: "Use Settings to change the existing owner password.",
      };
    }
    await requestOwnerPasswordWindow(process.env.PDPP_DATA_DIR || "data", {
      purpose: "initial_setup",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: actionMessage(err) };
  }
}

export async function restartAfterOwnerPasswordSetAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireDashboardAccess("/settings");
  if (process.env.PDPP_MANAGED_DESKTOP_HOST !== "1") {
    return {
      ok: false,
      message: "Open the DataConnect desktop app to apply the owner password.",
    };
  }
  if (!(await hasValidLocalOwnerCredentialRevealProofCookie())) {
    return {
      ok: false,
      message: "Open Settings from the local desktop app to apply the owner password.",
    };
  }
  try {
    await requestOwnerPasswordStackRestart(process.env.PDPP_DATA_DIR || "data");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: actionMessage(err) };
  }
}
