// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { Observation } from "@tnunamak/gozar";
import { ReachabilityError } from "./approvals.ts";

export type HostSettings = {
  revision: string;
  mode: "off" | "lan" | "route";
  password: Observation<boolean>;
  port: Observation<number | null>;
  target: Observation<string>;
  confinement: Observation<boolean>;
};
export interface HostSettingsBridge {
  apply(input: { expectedRevision: string; mode: HostSettings["mode"]; port: number | null }): Promise<HostSettings>;
  read(): Promise<HostSettings>;
}
export function validateHostSettingsInput(input: {
  expectedRevision: unknown;
  mode: unknown;
  port: unknown;
}): Parameters<HostSettingsBridge["apply"]>[0] {
  if (
    typeof input.expectedRevision !== "string" ||
    !input.expectedRevision ||
    !["off", "lan", "route"].includes(String(input.mode)) ||
    !(
      input.port === null ||
      (typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 && input.port <= 65_535)
    )
  ) {
    throw new ReachabilityError("invalid_input");
  }
  return {
    expectedRevision: input.expectedRevision,
    mode: input.mode as HostSettings["mode"],
    port: input.port as number | null,
  };
}

export function projectHostSettings(settings: HostSettings): HostSettings {
  const observation = <T>(input: Observation<T>): Observation<T> =>
    input.known ? { known: true, value: input.value } : { known: false, reason: input.reason };
  return {
    confinement: observation(settings.confinement),
    mode: settings.mode,
    password: observation(settings.password),
    port: observation(settings.port),
    revision: settings.revision,
    target: observation(settings.target),
  };
}
