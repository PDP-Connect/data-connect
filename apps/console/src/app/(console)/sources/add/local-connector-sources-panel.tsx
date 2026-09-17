"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react"
import { useRouter } from "next/navigation"
import { useCallback, useState, useSyncExternalStore, useTransition } from "react"
import type { ConnectorLocalSource } from "../../lib/connector-install-contract.ts"
import {
  getDeveloperModeServerSnapshot,
  getDeveloperModeSnapshot,
  subscribeToDeveloperMode,
} from "../../lib/source-setup-development.ts"
import {
  addConnectorLocalSourceAction,
  reloadConnectorLocalSourceAction,
  removeConnectorLocalSourceAction,
  selectConnectorLocalSourceAction,
} from "./connector-install-actions.ts"

function actionError(result: { ok: boolean; message?: string }): string | null {
  return result.ok
    ? null
    : (result.message ?? "Developer local source action failed.")
}

function LocalSourceRow({ source }: { source: ConnectorLocalSource }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const runAction = useCallback(
    (action: () => Promise<{ ok: boolean; message?: string }>) => {
      setMessage(null)
      startTransition(async () => {
        const result = await action()
        const error = actionError(result)
        if (error) {
          setMessage(error)
          return
        }
        router.refresh()
      })
    },
    [router]
  )
  return (
    <li
      className="grid gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-3"
      data-testid="local-source-row"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="pdpp-eyebrow rounded border border-status-warning-fg/30 bg-status-warning-bg px-1.5 py-0.5 text-status-warning-fg">
          Local
        </span>
        <span className="pdpp-caption font-medium text-foreground">
          {source.display_name}
        </span>
        <span className="pdpp-caption text-muted-foreground">
          {source.connector_key} · v{source.version}
        </span>
        {source.selected ? (
          <span className="pdpp-caption text-status-success-fg">
            Active for runs
          </span>
        ) : null}
      </div>
      <code
        className="pdpp-caption block break-all text-muted-foreground"
        data-testid="local-source-path"
      >
        {source.source_path}
      </code>
      <p className="pdpp-caption text-muted-foreground">
        Unsigned developer source. Reload after rebuilding the Collection
        Profile.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <IcButton
          disabled={isPending || source.selected}
          onClick={() =>
            runAction(() =>
              selectConnectorLocalSourceAction(
                source.connector_key,
                source.source_id
              )
            )
          }
          size="sm"
          type="button"
        >
          Use local
        </IcButton>
        <IcButton
          disabled={isPending || !source.selected}
          onClick={() =>
            runAction(() =>
              selectConnectorLocalSourceAction(source.connector_key, null)
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          Use registry
        </IcButton>
        <IcButton
          disabled={isPending}
          onClick={() =>
            runAction(() => reloadConnectorLocalSourceAction(source.source_id))
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          Reload
        </IcButton>
        <IcButton
          disabled={isPending}
          onClick={() =>
            runAction(() => removeConnectorLocalSourceAction(source.source_id))
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          Remove
        </IcButton>
        {message ? (
          <span
            aria-live="polite"
            className="pdpp-caption text-destructive"
            role="alert"
          >
            {message}
          </span>
        ) : null}
      </div>
    </li>
  )
}

export function LocalConnectorSourcesPanel({
  sources,
}: {
  sources: readonly ConnectorLocalSource[]
}) {
  const developerMode = useSyncExternalStore(
    subscribeToDeveloperMode,
    getDeveloperModeSnapshot,
    getDeveloperModeServerSnapshot,
  )
  const router = useRouter()
  const [sourcePath, setSourcePath] = useState("")
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  if (!developerMode) {
    return null
  }
  const addSource = () => {
    setMessage(null)
    startTransition(async () => {
      const result = await addConnectorLocalSourceAction(sourcePath)
      const error = actionError(result)
      if (error) {
        setMessage(error)
        return
      }
      setSourcePath("")
      router.refresh()
    })
  }
  return (
    <section className="mt-10 grid gap-3 border-t border-border/80 pt-6" data-testid="local-connector-sources">
      <div>
        <h2 className="pdpp-caption font-medium text-muted-foreground">
          Developer connector sources
        </h2>
        <p className="pdpp-caption mt-1 max-w-2xl text-muted-foreground">
          Load a local build with profile/collection-profile.json and
          dist/collection-profile.mjs. Local sources are unsigned and remain
          separate from verified registry packages.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <label className="grid gap-1" htmlFor="developer-connector-source-path">
          <span className="pdpp-caption font-medium text-foreground">
            Absolute source directory
          </span>
          <input
            className="min-h-9 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="developer-connector-source-path"
            onChange={event => setSourcePath(event.target.value)}
            placeholder="/path/to/collection-profile-build"
            value={sourcePath}
          />
        </label>
        <IcButton
          disabled={isPending || !sourcePath.trim()}
          onClick={addSource}
          size="sm"
          type="button"
          variant="ghost"
        >
          Add local source
        </IcButton>
      </div>
      {message ? (
        <p
          aria-live="polite"
          className="pdpp-caption text-destructive"
          role="alert"
        >
          {message}
        </p>
      ) : null}
      {sources.length > 0 ? (
        <ul className="grid gap-2" data-testid="local-source-list">
          {sources.map(source => (
            <LocalSourceRow key={source.source_id} source={source} />
          ))}
        </ul>
      ) : (
        <p className="pdpp-caption text-muted-foreground">
          No local connector sources configured.
        </p>
      )}
    </section>
  )
}
