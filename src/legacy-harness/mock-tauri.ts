// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { getLegacyHarnessFixture } from "./fixtures"
import type { LegacyHarnessScenario } from "./fixtures"

type EventPayload = { payload: unknown }
type EventHandler = (event: EventPayload) => void

let activeScenario: LegacyHarnessScenario = "home-sources"
const eventHandlers = new Map<string, Set<EventHandler>>()

export function setLegacyHarnessScenario(scenario: LegacyHarnessScenario) {
  activeScenario = scenario
}

export function getLegacyHarnessScenario() {
  return activeScenario
}

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const fixture = getLegacyHarnessFixture(activeScenario)

  switch (command) {
    case "get_platforms":
      return fixture.platforms as T
    case "check_connected_platforms":
      return fixture.connectedPlatforms as T
    case "load_runs":
      return fixture.runs as T
    case "check_connector_updates":
      return fixture.connectorUpdates as T
    case "download_connector":
      return undefined as T
    case "start_connector_run":
      if (activeScenario === "home-error") {
        throw new Error("Fixture connector failed to authorize")
      }
      return undefined as T
    case "start_installed_pdpp_connector_run":
      if (activeScenario === "home-error") {
        throw new Error("Fixture connector failed to authorize")
      }
      return undefined as T
    case "stop_connector_run":
    case "stop_installed_pdpp_connector_run":
    case "submit_installed_pdpp_interaction_response":
    case "reset_installed_pdpp_browser_profile":
    case "delete_exported_run":
    case "open_folder":
    case "open_platform_export_folder":
    case "open_personal_server_scope_folder":
    case "clear_browser_session":
    case "clear_personal_server_data":
      return undefined as T
    case "is_installed_pdpp_browser_setup_complete":
      return false as T
    case "get_user_data_path":
      return "/Users/demo/DataConnect" as T
    case "get_personal_server_data_path":
      return "/Users/demo/.dataconnect/personal-server" as T
    case "get_log_path":
      return "/Users/demo/.dataconnect/logs/dataconnect.log" as T
    case "check_browser_available":
      return {
        available: true,
        browser_type: "system",
        needs_download: false,
      } as T
    case "list_browser_sessions":
      return fixture.browserSessions as T
    case "test_nodejs":
      return {
        nodejs: "22.0.0",
        platform: "browser",
        arch: "x64",
        hostname: "legacy-harness",
        cpus: 8,
        memory: "16 GB",
        uptime: "fixture",
      } as T
    case "debug_connector_paths":
      return {
        connectorsRoot: "/Users/demo/.dataconnect/connectors",
        installed: fixture.platforms.map(platform => platform.id),
      } as T
    case "get_personal_server_status":
      return { running: false, port: null } as T
    case "load_run_export_data":
      return {
        exportSummary: { records: 214 },
        "chatgpt.conversations": [
          { id: "conversation-1", title: "Fixture conversation" },
        ],
      } as T
    case "load_latest_source_export_preview":
    case "load_source_export_preview_from_path":
      return {
        previewJson: JSON.stringify(
          {
            source: "legacy-harness",
            records: [{ id: "fixture-record-1", title: "Example record" }],
          },
          null,
          2
        ),
        isTruncated: false,
        filePath:
          typeof args?.exportPath === "string"
            ? args.exportPath
            : "/Users/demo/DataConnect/fixture/export.json",
        fileSizeBytes: 2_048,
        exportedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      } as T
    case "load_latest_source_export_full":
    case "load_source_export_full_from_path":
      return JSON.stringify({ records: [{ id: "fixture-record-1" }] }) as T
    default:
      return undefined as T
  }
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  const handlers = eventHandlers.get(event) ?? new Set<EventHandler>()
  const typedHandler = handler as (event: EventPayload) => void
  handlers.add(typedHandler)
  eventHandlers.set(event, handlers)
  return () => handlers.delete(typedHandler)
}

export function emitLegacyHarnessEvent<T>(event: string, payload: T) {
  eventHandlers.get(event)?.forEach(handler => handler({ payload }))
}

export async function getVersion() {
  return "legacy-harness"
}

export async function fetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  void init
  const url = String(input)
  if (url.endsWith("/health")) {
    return Response.json({
      identity: {
        address: "0x0000000000000000000000000000000000000001",
        publicKey: "fixture-public-key",
        serverId: "fixture-server",
      },
    })
  }
  if (url.includes("/v1/grants")) {
    return Response.json({ grants: [] })
  }
  if (url.includes("/v1/streams")) {
    return Response.json({ data: [] })
  }
  return Response.json({})
}

export async function open(target: string) {
  void target
  return undefined
}

export async function writeText(text: string) {
  void text
  return undefined
}
