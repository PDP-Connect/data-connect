// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useSelector } from "react-redux"
import { usePlatforms } from "@/hooks/usePlatforms"
import { installedPdppConnectionId, useConnector } from "@/hooks/useConnector"
import type { Platform, RootState } from "@/types"
import { PageContainer } from "@/components/elements/page-container"
import { DebugTogglePanel } from "@/components/elements/debug-toggle-panel"
import { Text } from "@/components/typography/text"
import { ConnectedSourcesList } from "@/pages/home/components/connected-sources-list"
import { ConnectorUpdates } from "@/pages/home/components/connector-updates"
import { AvailableSourcesList } from "@/pages/home/components/available-sources-list"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ROUTES } from "@/config/routes"
import {
  buildGrantSearchParams,
  getGrantParamsFromSearchParams,
} from "@/lib/grant-params"
import { getPlatformRegistryEntry } from "@/lib/platform/utils"
import {
  CONNECTED_SOURCES_UI_DEBUG_SCENARIO_VALUES,
  isConnectedSourcesUiDebugEnabled,
  resolveConnectedSourcesUiDebugPlatforms,
  resolveConnectedSourcesUiDebugRuns,
} from "./connected-sources-ui-debug"
import {
  getHomeImportSourcesScenario,
  HOME_IMPORT_SOURCES_SCENARIO_VALUES,
  isHomeImportSourcesDebugEnabled,
  resolveHomeImportSourcesUiDebugState,
} from "./home-import-sources-ui-debug"
import { useHomeManualUpload } from "./use-home-manual-upload"

type PendingPdppInteraction = {
  runId: string
  requestId: string
  kind: string
  message: string
  schema?: { properties?: Record<string, unknown> } | null
}

export function Home() {
  const homeDebugScenarioLabel: Record<string, string> = {
    "blocking-waiting": "blocking-waiting",
    background: "background",
    "phase-label": "phase-label",
    "eta-weak": "ETA weak",
    "eta-size": "ETA size",
    "eta-history": "ETA history",
    empty: "empty",
  }

  const location = useLocation()
  const navigate = useNavigate()
  const { platforms, isPlatformConnected, refreshConnectedStatus, loadPlatforms } =
    usePlatforms()
  const { startImport, stopExport } = useConnector()
  const runs = useSelector((state: RootState) => state.app.runs)
  const [deepLinkInput, setDeepLinkInput] = useState("")
  const [githubTokenDialogPlatform, setGithubTokenDialogPlatform] =
    useState<Platform | null>(null)
  const [githubTokenInput, setGithubTokenInput] = useState("")
  const [staticSecretDialogPlatform, setStaticSecretDialogPlatform] =
    useState<Platform | null>(null)
  const [setupSecretInputs, setSetupSecretInputs] = useState<
    Record<string, string>
  >({})
  const [pendingInteraction, setPendingInteraction] =
    useState<PendingPdppInteraction | null>(null)
  const [interactionInput, setInteractionInput] = useState("")
  const staticSecretSetup = staticSecretDialogPlatform?.setup
  const declaredStaticSecretFields =
    staticSecretSetup?.modality === "static_secret"
      ? staticSecretSetup.credentialCapture.fields
      : []
  const staticSecretSetupFields = declaredStaticSecretFields
  const setupSubmitDisabled = staticSecretSetupFields.some(
    field => field.required && !setupSecretInputs[field.name]?.trim()
  )
  const knownSuccessfulRunIdsRef = useRef<Set<string> | null>(null)
  const homeUiDebugEnabled = useMemo(
    () => isHomeImportSourcesDebugEnabled(location.search),
    [location.search]
  )
  const currentHomeUiDebugScenario = useMemo(
    () => getHomeImportSourcesScenario(location.search),
    [location.search]
  )
  const connectedSourcesUiDebugEnabled = useMemo(
    () => isConnectedSourcesUiDebugEnabled(location.search),
    [location.search]
  )
  const currentConnectedSourcesUiDebugScenario = useMemo(
    () => new URLSearchParams(location.search).get("connectedSourcesScenario"),
    [location.search]
  )
  const displayPlatforms = platforms

  useEffect(() => {
    const successfulRunIds = runs
      .filter(run => run.status === "success" || run.status === "partial")
      .map(run => run.id)

    if (knownSuccessfulRunIdsRef.current === null) {
      knownSuccessfulRunIdsRef.current = new Set(successfulRunIds)
      return
    }

    const knownSuccessfulRunIds = knownSuccessfulRunIdsRef.current
    const hasNewSuccess = successfulRunIds.some(runId => {
      if (knownSuccessfulRunIds.has(runId)) return false
      knownSuccessfulRunIds.add(runId)
      return true
    })

    if (hasNewSuccess) {
      void refreshConnectedStatus()
    }
  }, [refreshConnectedStatus, runs])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listen<PendingPdppInteraction>("pdpp-interaction", event => {
      setInteractionInput("")
      setPendingInteraction(event.payload)
    }).then(listener => {
      unlisten = listener
    })
    return () => unlisten?.()
  }, [])

  useEffect(() => {
    if (
      pendingInteraction &&
      !runs.some(
        run => run.id === pendingInteraction.runId && run.status === "running"
      )
    ) {
      setInteractionInput("")
      setPendingInteraction(null)
    }
  }, [pendingInteraction, runs])

  const runImportSource = useCallback(
    async (
      platform: Platform,
      options?: {
        githubToken?: string
        setupSecrets?: Record<string, string>
        importDirectory?: string | null
      }
    ) => {
      try {
        if (options === undefined) {
          await startImport(platform)
        } else {
          await startImport(platform, options)
        }
      } catch (error) {
        console.error("Import failed:", error)
      }
    },
    [startImport]
  )

  const manualUpload = useHomeManualUpload((platform, importDirectory) => {
    void runImportSource(platform, { importDirectory })
  })
  const { open: openManualUpload } = manualUpload

  const handleImportSource = useCallback(
    (platform: Platform) => {
      if (platform.setup?.modality === "manual_or_upload") {
        openManualUpload(platform)
        return
      }
      if (platform.id === "github-pdpp") {
        setGithubTokenInput("")
        setGithubTokenDialogPlatform(platform)
        return
      }
      if (platform.setup?.modality === "static_secret") {
        void invoke<boolean>("is_installed_pdpp_browser_setup_complete", {
          connectorId: platform.id,
          connectionId: installedPdppConnectionId(platform),
        })
          .then(setupComplete => {
            if (setupComplete) {
              void runImportSource(platform)
              return
            }
            setSetupSecretInputs({})
            setStaticSecretDialogPlatform(platform)
          })
          // A missing marker is the safe fallback for a failed or older host:
          // show first-setup recovery rather than accidentally sending no auth.
          .catch(() => {
            setSetupSecretInputs({})
            setStaticSecretDialogPlatform(platform)
          })
        return
      }

      void runImportSource(platform)
    },
    [openManualUpload, runImportSource]
  )

  const closeGithubTokenDialog = useCallback(() => {
    setGithubTokenDialogPlatform(null)
    setGithubTokenInput("")
  }, [])

  const submitGithubToken = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const platform = githubTokenDialogPlatform
      const githubToken = githubTokenInput.trim()
      if (!platform || !githubToken) return

      closeGithubTokenDialog()
      void runImportSource(platform, { githubToken })
    },
    [
      closeGithubTokenDialog,
      githubTokenDialogPlatform,
      githubTokenInput,
      runImportSource,
    ]
  )

  const closeStaticSecretDialog = useCallback(() => {
    setStaticSecretDialogPlatform(null)
    setSetupSecretInputs({})
  }, [])

  const submitStaticSecret = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const platform = staticSecretDialogPlatform
      if (!platform) return
      const setupSecrets = Object.fromEntries(
        staticSecretSetupFields.map(field => [
          field.name,
          field.name === "username"
            ? (setupSecretInputs[field.name] ?? "").trim()
            : (setupSecretInputs[field.name] ?? ""),
        ])
      )
      if (
        staticSecretSetupFields.some(
          field => field.required && !setupSecrets[field.name]?.trim()
        )
      ) {
        return
      }

      closeStaticSecretDialog()
      void runImportSource(platform, {
        setupSecrets,
      })
    },
    [
      staticSecretDialogPlatform,
      closeStaticSecretDialog,
      runImportSource,
      setupSecretInputs,
      staticSecretSetupFields,
    ]
  )

  const handleStopImport = useCallback(
    async (runId: string) => {
      try {
        await stopExport(runId)
      } catch (error) {
        console.error("Stop import failed:", error)
      }
    },
    [stopExport]
  )

  const handleReconnectSource = useCallback(
    async (platform: Platform) => {
      if (platform.id !== "chatgpt-pdpp") return
      try {
        await invoke("reset_installed_pdpp_browser_profile", {
          connectorId: platform.id,
          connectionId: installedPdppConnectionId(platform),
        })
        // The reset clears the non-secret setup marker. Re-enter the normal
        // setup gate so an expired session gets owner-attended recovery.
        handleImportSource(platform)
      } catch (error) {
        console.error("Failed to reset ChatGPT browser session:", error)
      }
    },
    [handleImportSource]
  )

  const respondToPendingInteraction = useCallback(
    async (status: "success" | "cancelled") => {
      const interaction = pendingInteraction
      if (!interaction) return
      const fields = Object.keys(interaction.schema?.properties ?? {})
      const requiresVerificationCode = interaction.kind === "otp"
      const data =
        status === "success" && requiresVerificationCode
          ? { code: interactionInput }
          : status === "success" && fields.length > 0
            ? { [fields[0]]: interactionInput }
            : undefined
      try {
        await invoke("submit_installed_pdpp_interaction_response", {
          runId: interaction.runId,
          requestId: interaction.requestId,
          status,
          data,
        })
      } catch (error) {
        console.error("Failed to submit connector interaction:", error)
      } finally {
        // OTP/recovery input is never promoted into Redux, logs, or storage.
        setInteractionInput("")
        setPendingInteraction(null)
      }
    },
    [interactionInput, pendingInteraction]
  )

  const handleTestDeepLink = useCallback(() => {
    const trimmed = deepLinkInput.trim()
    if (!trimmed) return
    try {
      const parsed = new URL(trimmed)
      const params = getGrantParamsFromSearchParams(parsed.searchParams)
      if (!params.sessionId && !params.appId) return
      const qs = buildGrantSearchParams(params).toString()
      const route = params.status === "success" ? ROUTES.grant : ROUTES.connect
      navigate(`${route}${qs ? `?${qs}` : ""}`)
    } catch {
      // invalid URL — ignore
    }
  }, [deepLinkInput, navigate])

  const setHomeUiDebugScenario = useCallback(
    (scenario: string | null) => {
      const nextParams = new URLSearchParams(location.search)
      if (scenario) nextParams.set("homeImportSourcesScenario", scenario)
      else nextParams.delete("homeImportSourcesScenario")
      nextParams.delete("scenario")
      navigate({ search: `?${nextParams.toString()}` }, { replace: true })
    },
    [location.search, navigate]
  )
  const setConnectedSourcesUiDebugScenario = useCallback(
    (scenario: string | null) => {
      const nextParams = new URLSearchParams(location.search)
      if (scenario) nextParams.set("connectedSourcesScenario", scenario)
      else nextParams.delete("connectedSourcesScenario")
      navigate({ search: `?${nextParams.toString()}` }, { replace: true })
    },
    [location.search, navigate]
  )

  const connectedCanonicalIdsFromRuns = useMemo(
    () =>
      new Set(
        runs
          .filter(
            run =>
              (run.status === "success" || run.status === "partial") &&
              Boolean(run.exportPath)
          )
          .map(
            run =>
              getPlatformRegistryEntry({
                id: run.platformId,
                name: run.name,
                company: run.company,
              })?.id
          )
          .filter((id): id is string => Boolean(id))
      ),
    [runs]
  )

  // Separate available platforms (memoized to avoid re-filtering on every render)
  const connectedPlatformsList = useMemo(() => {
    const connectedByCanonicalId = new Map<string, Platform>()

    for (const platform of displayPlatforms) {
      const canonicalId = getPlatformRegistryEntry(platform)?.id ?? platform.id
      const isConnected =
        isPlatformConnected(platform.id) ||
        connectedCanonicalIdsFromRuns.has(canonicalId)
      if (!isConnected) continue

      const existing = connectedByCanonicalId.get(canonicalId)
      if (!existing || platform.runtime === "pdpp-network") {
        connectedByCanonicalId.set(canonicalId, platform)
      }
    }

    return [...connectedByCanonicalId.values()]
  }, [connectedCanonicalIdsFromRuns, displayPlatforms, isPlatformConnected])

  const connectedPlatformIds = useMemo(
    () => connectedPlatformsList.map(platform => platform.id),
    [connectedPlatformsList]
  )
  const homeImportSourcesDebug = useMemo(
    () =>
      resolveHomeImportSourcesUiDebugState({
        search: location.search,
        realPlatforms: displayPlatforms,
        realRuns: runs,
        realConnectedPlatformIds: connectedPlatformIds,
      }),
    [connectedPlatformIds, displayPlatforms, location.search, runs]
  )
  const connectedSourcesPlatforms = useMemo(
    () =>
      resolveConnectedSourcesUiDebugPlatforms({
        platforms: connectedPlatformsList,
        search: location.search,
      }),
    [connectedPlatformsList, location.search]
  )
  const connectedSourcesRuns = useMemo(
    () =>
      resolveConnectedSourcesUiDebugRuns({
        runs,
        platforms: connectedSourcesPlatforms,
        search: location.search,
      }),
    [connectedSourcesPlatforms, location.search, runs]
  )

  const handleOpenRuns = useCallback(
    (platform: Platform) => {
      navigate(
        ROUTES.source.replace(
          ":platformId",
          getPlatformRegistryEntry(platform)?.id ?? platform.id
        )
      )
    },
    [navigate]
  )

  return (
    <PageContainer>
      <div className="space-y-w8">
        <Text as="h1" intent="subtitle" weight="medium">
          Your data
        </Text>
        <ConnectedSourcesList
          platforms={connectedSourcesPlatforms}
          runs={connectedSourcesRuns}
          headline="Your imported data"
          onOpenRuns={handleOpenRuns}
          onSyncSource={handleImportSource}
          onReconnectSource={handleReconnectSource}
        />
        <ConnectorUpdates onReloadPlatforms={loadPlatforms} />
        <AvailableSourcesList
          platforms={homeImportSourcesDebug.platforms}
          runs={homeImportSourcesDebug.runs}
          onExport={handleImportSource}
          onStopRun={handleStopImport}
          connectedPlatformIds={homeImportSourcesDebug.connectedPlatformIds}
          className="pt-2"
        />
      </div>

      {/* DEV ONLY SHORTCUT: RickRoll /connect link */}
      <AlertDialog
        open={Boolean(githubTokenDialogPlatform)}
        onOpenChange={open => {
          if (!open) closeGithubTokenDialog()
        }}
      >
        <AlertDialogContent size="sm" className="max-w-[380px]!">
          <form onSubmit={submitGithubToken} className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle className="w-full text-left">
                Connect GitHub
              </AlertDialogTitle>
              <AlertDialogDescription className="text-left">
                Enter a GitHub personal access token with the permissions needed
                for this import. DataConnect uses it for this run and does not
                save it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <label
                htmlFor="github-pdpp-token"
                className="text-xs font-medium text-foreground"
              >
                Personal access token
              </label>
              <Input
                id="github-pdpp-token"
                type="password"
                autoComplete="off"
                value={githubTokenInput}
                onChange={event => setGithubTokenInput(event.target.value)}
                autoFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                type="button"
                size="sm"
                onClick={closeGithubTokenDialog}
              >
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                size="sm"
                disabled={!githubTokenInput.trim()}
              >
                Start import
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(staticSecretDialogPlatform)}
        onOpenChange={open => {
          if (!open) closeStaticSecretDialog()
        }}
      >
        <AlertDialogContent size="sm" className="max-w-[380px]!">
          <form onSubmit={submitStaticSecret} className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle className="w-full text-left">
                Connect {staticSecretDialogPlatform?.name ?? "source"}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-left">
                {staticSecretDialogPlatform?.id === "chatgpt-pdpp"
                  ? "Use these only for initial setup or owner-mediated recovery. DataConnect passes them only to this run and does not save them."
                  : "DataConnect passes these credentials only to this run and does not save them."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {staticSecretSetupFields.map((field, index) => {
              const inputId = `${staticSecretDialogPlatform?.id ?? "pdpp"}-${field.name}`
              return (
                <div key={field.name} className="grid gap-1.5">
                  <label
                    htmlFor={inputId}
                    className="text-xs font-medium text-foreground"
                  >
                    {field.label ?? field.name}
                  </label>
                  <Input
                    id={inputId}
                    type={field.type ?? "password"}
                    autoComplete={field.autocomplete ?? "off"}
                    value={setupSecretInputs[field.name] ?? ""}
                    onChange={event =>
                      setSetupSecretInputs(current => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    autoFocus={index === 0}
                  />
                </div>
              )
            })}
            <AlertDialogFooter>
              <AlertDialogCancel
                type="button"
                size="sm"
                onClick={closeStaticSecretDialog}
              >
                Cancel
              </AlertDialogCancel>
              <Button type="submit" size="sm" disabled={setupSubmitDisabled}>
                {staticSecretDialogPlatform?.id === "chatgpt-pdpp"
                  ? "Start owner-attended sync"
                  : "Start import"}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(manualUpload.platform)}
        onOpenChange={open => {
          if (!open) manualUpload.close()
        }}
      >
        <AlertDialogContent size="sm" className="max-w-[380px]!">
          <AlertDialogHeader>
            <AlertDialogTitle className="w-full text-left">
              Import {manualUpload.platform?.name}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left">
              Choose the export file or folder you downloaded.
            </AlertDialogDescription>
            {manualUpload.error ? (
              <AlertDialogDescription className="text-left text-destructive">
                {manualUpload.error}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              type="button"
              size="sm"
              disabled={manualUpload.isPreparing}
              onClick={manualUpload.close}
            >
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              size="sm"
              disabled={manualUpload.isPreparing}
              onClick={() => void manualUpload.chooseImport(false)}
            >
              Choose file
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={manualUpload.isPreparing}
              onClick={() => void manualUpload.chooseImport(true)}
            >
              Choose folder
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(pendingInteraction)}>
        <AlertDialogContent size="sm" className="max-w-[380px]!">
          <AlertDialogHeader>
            <AlertDialogTitle className="w-full text-left">
              ChatGPT needs your attention
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left">
              {pendingInteraction?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingInteraction?.kind === "otp" ||
          Object.keys(pendingInteraction?.schema?.properties ?? {}).length >
            0 ? (
            <div className="grid gap-1.5">
              <label
                htmlFor="pdpp-interaction-input"
                className="text-xs font-medium text-foreground"
              >
                Verification code
              </label>
              <Input
                id="pdpp-interaction-input"
                type="password"
                autoComplete="one-time-code"
                value={interactionInput}
                onChange={event => setInteractionInput(event.target.value)}
                autoFocus
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              type="button"
              size="sm"
              onClick={() => void respondToPendingInteraction("cancelled")}
            >
              Cancel run
            </AlertDialogCancel>
            <Button
              type="button"
              size="sm"
              disabled={
                (pendingInteraction?.kind === "otp" ||
                  Object.keys(pendingInteraction?.schema?.properties ?? {})
                    .length > 0) &&
                !interactionInput
              }
              onClick={() => void respondToPendingInteraction("success")}
            >
              Continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {import.meta.env.DEV && (
        <DebugTogglePanel title="Home debug" openClassName="w-[900px]">
          <div className="grid grid-cols-12 gap-3 divide-x">
            <div className="col-span-7 space-y-2">
              <div className="space-y-2 pt-1">
                <p className="text-xs font-medium">Imported data</p>
                <div className="flex flex-wrap gap-2">
                  {CONNECTED_SOURCES_UI_DEBUG_SCENARIO_VALUES.map(scenario => (
                    <Button
                      key={scenario}
                      size="xs"
                      variant={
                        currentConnectedSourcesUiDebugScenario === scenario
                          ? "default"
                          : "outline"
                      }
                      onClick={() =>
                        setConnectedSourcesUiDebugScenario(scenario)
                      }
                    >
                      {scenario}
                    </Button>
                  ))}
                  <Button
                    size="xs"
                    variant={
                      connectedSourcesUiDebugEnabled ? "outline" : "default"
                    }
                    onClick={() => setConnectedSourcesUiDebugScenario(null)}
                  >
                    real
                  </Button>
                </div>
              </div>
              <div className="space-y-2 pt-1">
                <p className="text-xs font-medium">Import sources</p>
                <div className="flex flex-wrap gap-2">
                  {HOME_IMPORT_SOURCES_SCENARIO_VALUES.map(scenario => (
                    <Button
                      key={scenario}
                      size="xs"
                      variant={
                        currentHomeUiDebugScenario === scenario
                          ? "default"
                          : "outline"
                      }
                      onClick={() => setHomeUiDebugScenario(scenario)}
                    >
                      {homeDebugScenarioLabel[scenario] ?? scenario}
                    </Button>
                  ))}
                  <Button
                    size="xs"
                    variant={homeUiDebugEnabled ? "outline" : "default"}
                    onClick={() => setHomeUiDebugScenario(null)}
                  >
                    real
                  </Button>
                </div>
                {homeUiDebugEnabled ? (
                  <p className="text-[11px] text-foreground-muted">
                    target: {homeImportSourcesDebug.targetPlatformId ?? "none"}{" "}
                    · running:{" "}
                    {homeImportSourcesDebug.runningPlatformIds.join(", ") ||
                      "none"}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="col-span-5 space-y-2">
              <p className="text-xs font-medium">Grant flow</p>
              <div className="flex flex-wrap gap-2">
                <Button size="xs" variant="outline" asChild>
                  <a href="/connect?sessionId=grant-session-1770358735328&appId=rickroll&scopes=%5B%22read%3Achatgpt-conversations%22%5D">
                    Open Rickroll connect
                  </a>
                </Button>
              </div>
              <form
                className="flex flex-col gap-2"
                onSubmit={e => {
                  e.preventDefault()
                  handleTestDeepLink()
                }}
              >
                <input
                  type="text"
                  value={deepLinkInput}
                  onChange={e => setDeepLinkInput(e.target.value)}
                  placeholder="vana://connect?sessionId=...&secret=..."
                  className="rounded border px-2 py-1 text-xs"
                />
                <Button type="submit" size="xs" variant="outline">
                  Test deep link
                </Button>
              </form>
            </div>
          </div>
        </DebugTogglePanel>
      )}
    </PageContainer>
  )
}
