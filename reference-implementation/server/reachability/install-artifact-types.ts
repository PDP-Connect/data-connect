// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { Action } from "@tnunamak/gozar";
// Frozen v2 fields not declared on Action in artifact 0637743. Remove when
// the public root type includes them. This adds no runtime behavior.
export type InstallArtifactAction = Action & {
  artifact?: { url: string; sha256: string; platform: string; architecture: string };
  effects?: { writes: string[]; networkOrigins: string[]; requiresPrivilege: boolean; restartRequired: boolean };
};
