"use client"
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton, IcInput } from "@pdpp/brand-react"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { revokeOwnerBearerAction } from "../../settings/owner-sessions-actions.ts"
import {
  renameOwnerTokenAction,
  revokeOwnerClientTokenAction,
  revokeOwnerTokenAction,
} from "./actions.ts"
import { madeDate, type TokenGroup, type TokenRemoval } from "./token-model.ts"
export function PlainTokenList({
  groups,
  practice = false,
}: {
  groups: TokenGroup[]
  practice?: boolean
}) {
  return groups.length ? (
    <ul className="divide-y divide-border/70 border-y border-border/70">
      {groups.map(group => (
        <TokenRow key={group.key} group={group} practice={practice} />
      ))}
    </ul>
  ) : (
    <p className="py-4 text-muted-foreground">No tokens yet.</p>
  )
}
function RemoveOne({
  token,
  name,
  practice,
}: {
  token: TokenRemoval
  name: string
  practice: boolean
}) {
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  async function remove() {
    setBusy(true)
    try {
      const result = await revokeOwnerBearerAction(token.id)
      if (!result.ok) {
        setError(result.message || "Removal failed")
        return
      }
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Removal failed")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-2">
      {confirm ? (
        <div role="alertdialog" aria-label={`Remove ${name}`}>
          <p>Remove {name}? Anything using it stops working at once.</p>
          <div className="flex gap-2">
            {token.clientId ? (
              <form action={revokeOwnerClientTokenAction}>
                <input type="hidden" name="client_id" value={token.clientId} />
                <input type="hidden" name="token_id_public" value={token.id} />
                <IcButton disabled={practice} type="submit" size="sm">
                  Remove
                </IcButton>
              </form>
            ) : (
              <IcButton disabled={practice || busy} onClick={remove} size="sm">
                Remove
              </IcButton>
            )}
            <IcButton
              variant="ghost"
              size="sm"
              onClick={() => setConfirm(false)}
            >
              Cancel
            </IcButton>
          </div>
        </div>
      ) : (
        <IcButton variant="ghost" size="sm" onClick={() => setConfirm(true)}>
          Remove
        </IcButton>
      )}
      {error ? (
        <div role="status">
          <p>This could not be removed. Try again.</p>
          <IcButton
            variant="ghost"
            onClick={() => navigator.clipboard.writeText(error)}
          >
            Copy details for support
          </IcButton>
        </div>
      ) : null}
    </div>
  )
}
function TokenRow({
  group,
  practice,
}: {
  group: TokenGroup
  practice: boolean
}) {
  const [show, setShow] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)
  const router = useRouter()
  async function removeAll() {
    try {
      for (const token of group.tokens) {
        const result = await revokeOwnerBearerAction(token.id);
        if (!result.ok) throw Error(result.message || "Removal failed");
      }
      router.refresh(); setRemove(false);
    } catch (cause) { setGroupError(cause instanceof Error ? cause.message : "Removal failed"); }
  }
  const [rename, setRename] = useState(false)
  const [remove, setRemove] = useState(false)
  return (
    <li className="grid gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <p>{group.name}</p>
          <p className="text-sm text-muted-foreground">
            Can read everything · {madeDate(group.createdAt)}
            {group.count > 1 ? ` · ${group.count} tokens` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {group.clientId ? (
            <>
              <IcButton
                variant="ghost"
                size="sm"
                onClick={() => setRename(!rename)}
              >
                Rename
              </IcButton>
              <IcButton
                variant="ghost"
                size="sm"
                onClick={() => setRemove(true)}
              >
                {group.count > 1 ? `Remove all ${group.count}` : "Remove"}
              </IcButton>
            </>
          ) : group.count === 1 && group.tokens[0] ? (
            <RemoveOne
              token={group.tokens[0]}
              name={group.name}
              practice={practice}
            />
          ) : null}
          {!group.clientId && group.count > 1 ? <IcButton variant="ghost" onClick={() => setRemove(true)}>Remove all {group.count}</IcButton> : null}
          {group.count > 1 ? (
            <IcButton variant="ghost" size="sm" onClick={() => setShow(!show)}>
              {show ? "Hide them" : "Show them"}
            </IcButton>
          ) : null}
        </div>
      </div>
      {rename && group.clientId ? (
        <form action={renameOwnerTokenAction} className="flex flex-wrap gap-2">
          <input type="hidden" name="client_id" value={group.clientId} />
          <IcInput
            aria-label={`Name for ${group.name}`}
            name="client_name"
            defaultValue={group.name}
            required
          />
          <IcButton disabled={practice} type="submit" size="sm">
            Save name
          </IcButton>
          <IcButton variant="ghost" size="sm" onClick={() => setRename(false)}>
            Cancel
          </IcButton>
        </form>
      ) : null}
      {remove && !group.clientId ? <div role="alertdialog" aria-label={`Remove ${group.name}`}><p>Remove all {group.count} tokens for {group.name}? Anything using them stops working at once.</p><IcButton disabled={practice} onClick={removeAll}>Remove all {group.count}</IcButton><IcButton variant="ghost" onClick={() => setRemove(false)}>Cancel</IcButton></div> : null}
      {groupError ? <div role="status"><p>Some tokens could not be removed. Refresh this page to check before trying again.</p><IcButton variant="ghost" onClick={() => navigator.clipboard.writeText(groupError)}>Copy details for support</IcButton></div> : null}
      {remove && group.clientId ? (
        <div role="alertdialog" aria-label={`Remove ${group.name}`}>
          <p>Remove {group.name}? Anything using it stops working at once.</p>
          <div className="flex gap-2">
            <form action={revokeOwnerTokenAction}>
              <input type="hidden" name="client_id" value={group.clientId} />
              <IcButton disabled={practice} type="submit" size="sm">
                {group.count > 1 ? `Remove all ${group.count}` : "Remove"}
              </IcButton>
            </form>
            <IcButton
              variant="ghost"
              size="sm"
              onClick={() => setRemove(false)}
            >
              Cancel
            </IcButton>
          </div>
        </div>
      ) : null}
      {show ? (
        <ul className="divide-y divide-border pl-4">
          {(showAll ? group.tokens : group.tokens.slice(0, 5)).map((token, index) => (
            <li
              className="flex items-center justify-between gap-3 py-3"
              key={token.id}
            >
              <p className="text-sm text-muted-foreground">
                Token {index + 1} · {madeDate(token.createdAt)}
              </p>
              <RemoveOne
                token={token}
                name={`${group.name} token ${index + 1}`}
                practice={practice}
              />
            </li>
          ))}
          {!showAll && group.tokens.length > 5 ? <li><IcButton variant="ghost" onClick={() => setShowAll(true)}>Show all {group.count}</IcButton></li> : null}
        </ul>
      ) : null}
      {group.incomplete ? (
        <p className="text-sm text-muted-foreground">
          Some individual tokens could not be loaded. Refresh this page to try
          again. You can still remove the whole script.
        </p>
      ) : null}
    </li>
  )
}
