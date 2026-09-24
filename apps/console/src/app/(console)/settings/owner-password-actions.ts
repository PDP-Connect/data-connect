"use server"

import { revalidatePath } from "next/cache"
import {
  ownerOsReauthAllowsReveal,
  ownerOsReauthSucceeded,
  readOwnerOsReauthRequest,
  requestOwnerOsReauth,
  requestOwnerPasswordWindow,
} from "pdpp-reference-implementation/owner-password-owner-set"
import { requireDashboardAccess } from "../lib/dashboard-access.ts"
import { hasLocalOwnerCredentialRevealProofCookie } from "../lib/owner-credential-client.ts"
import { redirectToOwnerLogin } from "../lib/login-redirect.ts"
import { getAsInternalUrl, withOwnerSessionCookie } from "../lib/owner-token.ts"

export interface ChangeOwnerPasswordResult {
  ok: boolean
  message?: string
  linuxPolkitUnverified?: boolean
}

interface OwnerPasswordError {
  error?: {
    code?: string
    message?: string
  }
}

const OWNER_OS_REAUTH_TIMEOUT_MS = 120_000
const OWNER_OS_REAUTH_POLL_MS = 250

const dataDir = () => process.env.PDPP_DATA_DIR || "data"

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type OwnerOsReauthResult =
  | {
      ok: true
      linuxPolkitUnverified: boolean
      grantId?: string
      requestId: number
    }
  | { ok: false; message: string }

async function requireOwnerOsReauthGrant(
  options: { allowLinuxLocalReveal?: boolean } = {}
): Promise<OwnerOsReauthResult> {
  await requireDashboardAccess("/settings")
  if (process.env.PDPP_MANAGED_DESKTOP_HOST !== "1") {
    return {
      ok: false,
      message: "Open the DataConnect desktop app to confirm this action.",
    }
  }
  if (process.platform === "linux" && !options.allowLinuxLocalReveal) {
    return {
      ok: false,
      message:
        "Linux owner password changes require verified OS re-authentication before this action is available.",
    }
  }
  if (
    process.platform === "linux" &&
    !(await hasLocalOwnerCredentialRevealProofCookie())
  ) {
    return {
      ok: false,
      message:
        "Open Settings from the local desktop app to reveal the owner password on Linux.",
    }
  }
  const { requestId } = await requestOwnerOsReauth(dataDir())
  const deadline = Date.now() + OWNER_OS_REAUTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    const state = await readOwnerOsReauthRequest(dataDir(), requestId)
    if (state.completedRequestId === requestId) {
      if (state.error) return { ok: false, message: state.error }
      const reauthSucceeded = options.allowLinuxLocalReveal
        ? ownerOsReauthAllowsReveal(state, requestId)
        : ownerOsReauthSucceeded(state, requestId)
      if (!reauthSucceeded) {
        return {
          ok: false,
          message: "OS re-authentication did not finish successfully.",
        }
      }
      return {
        grantId: state.grantId,
        linuxPolkitUnverified:
          state.status === "skipped_linux_polkit_unverified",
        ok: true,
        requestId,
      }
    }
    await sleep(OWNER_OS_REAUTH_POLL_MS)
  }
  return { ok: false, message: "OS re-authentication did not finish." }
}

export async function requireOwnerOsReauthAction(): Promise<
  { ok: true; linuxPolkitUnverified: boolean } | { ok: false; message: string }
> {
  const result = await requireOwnerOsReauthGrant({
    allowLinuxLocalReveal: true,
  })
  if (!result.ok) return result
  return { linuxPolkitUnverified: result.linuxPolkitUnverified, ok: true }
}

export async function requestReauthenticatedOwnerPasswordWindowAction(): Promise<ChangeOwnerPasswordResult> {
  const reauth = await requireOwnerOsReauthGrant()
  if (!reauth.ok) return reauth
  if (!reauth.grantId)
    return {
      ok: false,
      message: "OS re-authentication did not issue a password-change grant.",
    }
  await requestOwnerPasswordWindow(dataDir(), {
    grantForRequestId: reauth.requestId,
    grantId: reauth.grantId,
    purpose: "change",
  })
  revalidatePath("/settings")
  return { ok: true, linuxPolkitUnverified: reauth.linuxPolkitUnverified }
}

export async function requestDesktopOwnerPasswordChangeAction(): Promise<ChangeOwnerPasswordResult> {
  await requireDashboardAccess("/settings")
  if (
    process.env.PDPP_MANAGED_DESKTOP_HOST !== "1" ||
    process.env.PDPP_OWNER_PASSWORD_SOURCE !== "desktop_generated"
  ) {
    return {
      ok: false,
      message: "Desktop password change is unavailable in this mode.",
    }
  }
  try {
    return await requestReauthenticatedOwnerPasswordWindowAction()
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : "Could not start desktop password change.",
    }
  }
}

export async function changeOwnerPasswordAction(
  currentPassword: string,
  newPassword: string
): Promise<ChangeOwnerPasswordResult> {
  await requireDashboardAccess("/settings")
  const response = await fetch(
    `${getAsInternalUrl()}/owner/password/change`,
    await withOwnerSessionCookie({
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    })
  )
  if (response.status === 204) {
    revalidatePath("/settings")
    return { ok: true }
  }

  const body = (await response
    .json()
    .catch(() => null)) as OwnerPasswordError | null
  if (
    response.status === 401 &&
    body?.error?.code === "owner_session_required"
  ) {
    await redirectToOwnerLogin("/settings")
  }
  return {
    ok: false,
    message: body?.error?.message ?? "Could not change the owner password.",
  }
}
