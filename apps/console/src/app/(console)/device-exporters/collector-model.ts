// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { DeviceExporter } from "../lib/ref-client.ts"
import { classifyHeartbeatFreshness } from "./render.ts"
export function collectorGroups(devices: DeviceExporter[]) {
  const active = devices.filter(device => device.status !== "revoked")
  return [
    {
      title: "Sending data",
      devices: active.filter(
        device =>
          classifyHeartbeatFreshness(device.last_heartbeat_at, device.stale) ===
          "fresh"
      ),
    },
    {
      title: "Not heard from lately",
      devices: active.filter(
        device =>
          classifyHeartbeatFreshness(device.last_heartbeat_at, device.stale) ===
          "stale"
      ),
    },
    {
      title: "Set up but never sent anything",
      devices: active.filter(
        device =>
          classifyHeartbeatFreshness(device.last_heartbeat_at, device.stale) ===
          "never"
      ),
    },
  ]
}
export function collectorTime(
  value: string | null | undefined,
  now = Date.now()
) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Time not known"
  const minutes = Math.max(0, Math.round((now - Date.parse(value)) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}
export function buildCollectorPractice(state: string): DeviceExporter[] | null {
  if (state === "none") return []
  if (state !== "real") return null
  return Array.from({ length: 32 }, (_, index) => ({
    object: "device_exporter",
    device_id: `practice-${index}`,
    subject_id: "practice",
    display_name: `Computer ${index + 1}`,
    created_at: "2026-11-03T10:00:00Z",
    last_heartbeat_at:
      index < 9
        ? new Date(
            Date.now() - (index < 4 ? 5 * 60_000 : 9 * 86_400_000)
          ).toISOString()
        : null,
    status: index >= 26 ? "revoked" : "active",
    stale: index >= 4 && index < 9,
    source_instances: [],
  }))
}
