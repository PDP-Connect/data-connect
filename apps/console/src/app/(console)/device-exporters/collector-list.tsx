"use client"
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { ReenrollButton } from "./reenroll-button.tsx";
import { IcButton } from "@pdpp/brand-react"
import Link from "next/link"
import { useState } from "react"
import type { DeviceExporter } from "../lib/ref-client.ts"
import { connectionDisplayName } from "../lib/connection-display-name.ts"
import { revokeDeviceExporterAction } from "./actions.ts"
import { collectorGroups, collectorTime } from "./collector-model.ts"
export function CollectorList({
  devices,
  practice = false,
  collectorConnectorIds = [],
  referenceBaseUrl,
}: {
  devices: DeviceExporter[]
  practice?: boolean
  collectorConnectorIds?: readonly string[]
  referenceBaseUrl?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const groups = collectorGroups(devices)
  if (groups.every(group => group.devices.length === 0))
    return <p>No collectors yet.</p>
  return (
    <div className="grid gap-6">
      {groups.map((group, index) =>
        group.devices.length ? (
          <section key={group.title} className="grid gap-2">
            <h2>
              {group.title} · {group.devices.length}
            </h2>
            <ul className="divide-y divide-border/70 border-y border-border/70">
              {(index === 2 && !showAll
                ? group.devices.slice(0, 5)
                : group.devices
              ).map(device => (
                <li className="grid gap-2 py-4" key={device.device_id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid gap-1">
                      <p>{device.display_name || "Your device"}</p>
                      <p className="text-sm text-muted-foreground">
                        {index === 2
                          ? `Set up on ${new Date(device.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}.`
                          : `Last heard from ${collectorTime(device.last_heartbeat_at)}`}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {device.source_instances.map(source =>
                          source.connector_instance_id ? (
                            <Link
                              className="text-sm underline"
                              href={`/sources/${encodeURIComponent(source.connector_instance_id)}`}
                              key={source.source_instance_id}
                            >
                              {connectionDisplayName(
                                source.display_name,
                                null,
                                source.connector_id
                              )}
                            </Link>
                          ) : (
                            <span key={source.source_instance_id}>
                              Data source not linked yet
                            </span>
                          )
                        )}
                      </div>
                    </div>
                    <IcButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoving(device.device_id)}
                    >
                      Remove
                    </IcButton>
                  </div>
                  {index > 0 && referenceBaseUrl && device.source_instances.some((source) => collectorConnectorIds.includes(source.connector_id)) ? (() => {
                    const source = device.source_instances.find((source) => collectorConnectorIds.includes(source.connector_id))!;
                    return <ReenrollButton connectorId={source.connector_id} localBindingName={source.local_binding_name} referenceBaseUrl={referenceBaseUrl} />;
                  })() : null}
                  {removing === device.device_id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Remove ${device.display_name || "device"}`}
                      className="grid gap-2"
                    >
                      <p>
                        This stops this device from sending data to DataConnect.
                        Your saved records stay.
                      </p>
                      <div className="flex gap-2">
                        <form action={revokeDeviceExporterAction}>
                          <input
                            name="device_id"
                            type="hidden"
                            value={device.device_id}
                          />
                          <input
                            name="confirm_revoke"
                            type="hidden"
                            value="yes"
                          />
                          <IcButton size="sm" disabled={practice} type="submit">
                            Remove
                          </IcButton>
                        </form>
                        <IcButton
                          size="sm"
                          variant="ghost"
                          onClick={() => setRemoving(null)}
                        >
                          Cancel
                        </IcButton>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {index === 2 && group.devices.length > 5 && !showAll ? (
              <IcButton
                className="w-fit"
                variant="ghost"
                onClick={() => setShowAll(true)}
              >
                Show all {group.devices.length}
              </IcButton>
            ) : null}
          </section>
        ) : null
      )}
    </div>
  )
}
