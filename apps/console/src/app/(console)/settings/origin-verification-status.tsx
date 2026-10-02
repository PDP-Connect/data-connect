// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx"
import type { OriginVerificationDisplay } from "./remote-access.ts"

function checkedTime(checkedAt: number): string {
  return new Date(checkedAt * 1000).toLocaleTimeString()
}

/**
 * Where the public origin actually leads, as the desktop supervisor last
 * observed it, plus what the owner must do about it. Rendered only from
 * `originVerificationDisplay` -- the probe's reading and the provider's own
 * `binding` answer -- so no line here depends on which provider is selected.
 *
 * Says only what was observed: "reaches this DataConnect" requires a fresh
 * origin-proof answer, and an unverified or stale reading is said to be
 * exactly that, never shown as healthy.
 */
export function OriginVerificationStatus({
  consolePort,
  display,
  origin,
}: {
  consolePort: number | null
  display: OriginVerificationDisplay
  origin: string
}) {
  const { agentExited, binding, reading } = display
  const target = consolePort != null ? `http://127.0.0.1:${consolePort}` : null
  const misrouted = reading.kind === "reaches_something_else" || reading.kind === "unreachable"
  return (
    <div className="grid gap-1">
      {reading.kind === "reaches_this_console" ? (
        <p className="pdpp-caption text-foreground" role="status">
          Verified at {checkedTime(reading.checkedAt)}: this address reaches this DataConnect.
        </p>
      ) : reading.kind === "reaches_something_else" ? (
        <p className="pdpp-caption text-destructive" role="alert">
          At {checkedTime(reading.checkedAt)} this address answered (HTTP {reading.status}), but
          not from this DataConnect. Visitors to{" "}
          <span className="break-all font-mono">{origin}</span> are not reaching your console.
        </p>
      ) : reading.kind === "unreachable" ? (
        <p className="pdpp-caption text-destructive" role="alert">
          At {checkedTime(reading.checkedAt)} nothing answered at this address: {reading.reason}
        </p>
      ) : reading.kind === "stale" ? (
        <p className="pdpp-caption text-muted-foreground" role="status">
          Not checked since {checkedTime(reading.checkedAt)}, so DataConnect cannot say whether
          this address reaches it right now.
        </p>
      ) : (
        <p className="pdpp-caption text-muted-foreground" role="status">
          Not verified yet. DataConnect checks every minute whether this address reaches it.
        </p>
      )}
      {agentExited ? (
        <p className="pdpp-caption text-destructive" role="alert">
          The tunnel process on this computer has stopped.
        </p>
      ) : null}
      {binding?.kind === "owner_maintained" ? (
        <p className="pdpp-caption text-muted-foreground">
          DataConnect does not control where this address leads. Set it in {binding.where_to_set}
          {target ? (
            <>
              , pointing at <span className="select-all font-mono text-foreground/80">{target}</span>
            </>
          ) : null}
          .{" "}
          {binding.action_url ? (
            <>
              <OpenExternalLink className="underline" href={binding.action_url}>
                Open in browser
              </OpenExternalLink>
              .{" "}
            </>
          ) : null}
          The console address below says whether this port stays the same across restarts.
        </p>
      ) : binding?.kind === "app_supplied" && misrouted ? (
        <p className="pdpp-caption text-muted-foreground">
          DataConnect sets where this address leads itself. Turn Public URL off and on again to
          restart the tunnel.
        </p>
      ) : null}
    </div>
  )
}
