// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { projectInventory } from "pdpp-reference-implementation/reachability-projection"
import { useState } from "react"
import { Button } from "@/components/ui/button.tsx"
import {
  ErrorNotice,
  ReachabilityFailure,
  toDisplayError,
} from "./diagnostics.tsx"
import { plain } from "./plain-text.ts"
import type { requestReachability } from "./reachability-client.ts"

type Provider = ReturnType<typeof projectInventory>["providers"][number]
type Migration = Extract<
  Provider["configuration"],
  { known: false }
>["migration"]

export function EarlierSetupCard({
  provider,
  migration,
  request,
  disabled,
  onChange,
}: {
  provider: Provider
  migration: Migration
  request: typeof requestReachability
  disabled: boolean
  onChange: () => void
}) {
  const [selected, setSelected] = useState<{
    fromRegistryId: string
    draftId: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ReturnType<
    typeof toDisplayError
  > | null>(null)
  const unavailable = migration.recovery?.available === false
  async function discard() {
    if (!selected || busy || disabled || unavailable) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await request(
        `/providers/${encodeURIComponent(provider.providerId)}/earlier-drafts/${encodeURIComponent(selected.draftId)}/discard`,
        { fromRegistryId: selected.fromRegistryId }
      )
      if (!result.ok) throw new ReachabilityFailure(result)
      setSelected(null)
      onChange()
    } catch (error) {
      setFailure(toDisplayError(error, "action", undefined, "change"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label={`${plain(provider.label)}: Earlier setup needs attention`}
      className="grid gap-3 rounded-xl border p-4"
    >
      <h3 className="pdpp-label">Earlier setup needs attention</h3>
      <p>{plain(provider.label)}</p>
      {unavailable ? (
        <p role="status">
          Needs attention: no supported recovery action. Discarding a draft
          cannot clear the earlier setup journal.
        </p>
      ) : null}
      {migration.candidates.map(candidate => (
        <div className="grid gap-2" key={candidate.fromRegistryId}>
          <p>Earlier registry: {candidate.fromRegistryId}</p>
          {candidate.unaddressableSetupOperations > 0 ? (
            <p>
              Setup journals without a supported recovery action:{" "}
              {candidate.unaddressableSetupOperations}
            </p>
          ) : null}
          {candidate.draftIds.map(draftId => (
            <div key={draftId}>
              <p>Draft: {draftId}</p>
              {!unavailable ? (
                <Button
                  disabled={disabled || busy}
                  onClick={() =>
                    setSelected({
                      fromRegistryId: candidate.fromRegistryId,
                      draftId,
                    })
                  }
                  type="button"
                  variant="outline"
                >
                  Discard draft {draftId}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {selected && !unavailable ? (
        <div
          className="grid gap-2"
          role="group"
          aria-label="Confirm earlier draft discard"
        >
          <p>
            Discard draft {selected.draftId} from {selected.fromRegistryId} for{" "}
            {plain(provider.label)}? This removes the saved inputs for this
            draft.
          </p>
          <div className="flex gap-3">
            <Button
              disabled={disabled || busy}
              onClick={() => void discard()}
              type="button"
            >
              Confirm discard
            </Button>
            <Button
              disabled={busy}
              onClick={() => setSelected(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {failure ? <ErrorNotice action="change" error={failure} /> : null}
    </section>
  )
}
