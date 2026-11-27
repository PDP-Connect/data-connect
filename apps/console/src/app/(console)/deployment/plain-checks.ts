// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  RefreshTokenProbe,
  ServerInputs,
  ReadinessStatus,
} from "../components/deployment-readiness-rows.ts"
export interface PlainCheck {
  name: string
  sentence: string
  status: ReadinessStatus
  action?: string
  href?: string
}
export function plainServerChecks(
  inputs: ServerInputs,
  address: string | null,
  probe: RefreshTokenProbe,
  desktop = false
): PlainCheck[] {
  const expected = inputs.referenceOriginConfigured
  const mismatch =
    address &&
    expected &&
    address.replace(/\/$/, "") !== expected.replace(/\/$/, "")
  const warm = inputs.embeddingWarmStatus
  const searchOff =
    !inputs.embeddingBackendConfigured ||
    warm?.mode === "lexical_only" ||
    (inputs.embeddingModelCachePresent === false &&
      inputs.embeddingDownloadAllowed === false)
  const searchStatus = searchOff
      ? "ok"
      : inputs.embeddingBackendAvailable && inputs.embeddingModelCachePresent
        ? "ok"
        : warm?.status === "downloading" || warm?.status === "not_started"
          ? "info"
          : "warn" as const;
  return [
    {
      name: "Password",
      status: inputs.ownerPasswordProvenance === "absent" ? "error" : "ok",
      sentence:
        inputs.ownerPasswordProvenance === "absent"
          ? "No password is set. Anyone who can open this address can open DataConnect."
          : "A password protects DataConnect.",
      ...(inputs.ownerPasswordProvenance === "absent"
        ? { action: "Set a password", href: "/settings/sign-in" }
        : {}),
    },
    {
      name: "Address",
      status: mismatch ? "error" : address ? "ok" : "unknown",
      sentence: mismatch
        ? `This browser reached DataConnect at ${address}, but DataConnect expects ${expected}. Apps may fail to connect until they match.`
        : address
          ? `DataConnect is at ${expected || address}.`
          : "Checking the address…",
      ...(mismatch
        ? { action: desktop ? "Open remote access" : "Change the address where DataConnect is installed.", ...(desktop ? { href: "/settings/remote-access" } : {}) }
        : {}),
    },
    {
      name: "Storage",
      status: inputs.vectorIndexState === "stale" ? "warn" : "ok",
      sentence:
        inputs.vectorIndexState === "building"
          ? "The search index is being rebuilt. Search may miss recent records until it finishes."
          : inputs.vectorIndexState === "stale"
            ? "The search index needs attention. Search may miss recent records."
            : inputs.vectorIndexKind === null &&
                inputs.vectorIndexState === null
              ? "Your data is stored. A search index has not been set up yet."
              : "Your data is stored and indexed.",
      ...(inputs.vectorIndexState === "stale"
        ? { action: "Restart DataConnect." }
        : {}),
    },
    {
      name: "Search",
      status: searchStatus,
      sentence: searchOff
        ? "Search by words works. Search by meaning is off."
        : inputs.embeddingBackendAvailable && inputs.embeddingModelCachePresent
          ? "Search by words and by meaning works."
          : warm?.status === "failed"
            ? "Search by meaning could not start. Search by words still works."
            : warm?.status === "downloading"
              ? "Search by meaning is getting ready. Search by words works."
              : warm?.status === "not_started"
                ? "Search by meaning has not started yet. Search by words works."
                : "DataConnect could not check search by meaning. Search by words works.",
      ...(searchStatus === "warn" ? { action: "Restart DataConnect." } : {}),
    },
    {
      name: "Apps staying connected",
      status:
        probe.state === "loading"
          ? "unknown"
          : probe.state === "unreachable"
            ? "warn"
            : probe.refreshTokenSupported
              ? "ok"
              : "error",
      sentence:
        probe.state === "loading"
          ? "Checking whether apps can stay connected…"
          : probe.state === "unreachable"
            ? "DataConnect could not check whether apps can stay connected."
            : probe.refreshTokenSupported
              ? "Apps can stay connected without asking you again."
              : "This version of DataConnect is too old for apps to stay connected. Update DataConnect.",
      ...(probe.state === "unreachable"
        ? { action: "Check again.", href: "/deployment" }
        : {}),
    },
  ]
}
export function checksHeadline(rows: PlainCheck[]): string {
  const blocked = rows.filter(row => row.status === "error").length
  const attention = rows.filter(row => row.status === "warn").length
  if (blocked)
    return `DataConnect can’t work until ${blocked} ${blocked === 1 ? "thing is" : "things are"} fixed.`
  if (attention)
    return `${attention} ${attention === 1 ? "check needs" : "checks need"} attention.`
  if (rows.some(row => row.status === "unknown")) return "Checking DataConnect…"
  if (rows.some(row => row.status === "info"))
    return "Search by meaning is still getting ready."
  return "Everything is working."
}
export function buildServerPractice(state: string) {
  if (
    !["fine", "search-off", "attention", "blocked", "checking"].includes(state)
  )
    return null
  const inputs: ServerInputs = {
    databasePath: "",
    diskHeadroom: [],
    embeddingBackendAvailable: true,
    embeddingBackendConfigured: state !== "search-off",
    embeddingDownloadAllowed: true,
    embeddingModelCachePresent: state !== "attention",
    ownerPasswordProvenance: state === "blocked" ? "absent" : "redacted",
    referenceOriginConfigured: "https://dataconnect.example",
    vectorIndexKind: "sqlite-vec",
    vectorIndexState: "built",
    ...(state === "attention"
      ? {
          embeddingWarmStatus: {
            mode: "semantic",
            status: "failed",
            error: "practice",
          } as ServerInputs["embeddingWarmStatus"],
        }
      : {}),
  }
  return {
    inputs,
    address: state === "checking" ? null : "https://dataconnect.example",
    probe:
      state === "checking"
        ? ({ state: "loading" } as RefreshTokenProbe)
        : ({
            state: "loaded",
            refreshTokenSupported: true,
          } as RefreshTokenProbe),
  }
}
