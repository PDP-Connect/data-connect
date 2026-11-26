// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The source-kind fact shared by server controls, run admission and coverage. */
export interface ConnectorInstancePlacement {
  readonly sourceKind?: string | null;
}

export const NON_LOCAL_DEVICE_COVERAGE_REASON = "connection_source_kind_not_local_device" as const;

/**
 * The spine actor_type of a device terminal run event. Stored as the run's
 * provenance (`run_history.actor_type`); no server run uses it.
 */
export const LOCAL_DEVICE_ACTOR_TYPE = "local_device" as const;

export function isLocalDeviceConnection(instance: ConnectorInstancePlacement): boolean {
  return instance.sourceKind === "local_device";
}

/** Refuse server controls that would try to operate a paired-device connection remotely. */
export function assertRemoteControlSupported(instance: ConnectorInstancePlacement): void {
  if (isLocalDeviceConnection(instance)) {
    const error = new Error(
      "Local-device connections are collected by their paired device and cannot be started by the reference server."
    ) as Error & { code: string };
    error.code = "local_device_control_unsupported";
    throw error;
  }
}
