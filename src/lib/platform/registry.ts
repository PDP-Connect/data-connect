// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export type PlatformRegistryAvailability =
  | "available"
  | "comingSoon"
  | "requiresConnector"

export interface PlatformRegistryEntry {
  id: string
  displayName: string
  brandDomain?: string
  iconKey?: string
  platformIds?: string[]
  aliases?: string[]
  // Currently unused by runtime rendering/selection flows; retained for team metadata workflows.
  availability?: PlatformRegistryAvailability
  // Currently unused by runtime rendering/selection flows; retained for team metadata workflows.
  showInConnectList?: boolean
  ingestScope?: string
}

import { PLATFORM_REGISTRY_GENERATED } from "./registry.generated"

const PLATFORM_REGISTRY_COMING_SOON: PlatformRegistryEntry[] = [
  {
    id: "x",
    displayName: "X (Twitter)",
    brandDomain: "x.com",
    iconKey: "x",
    platformIds: ["x"],
    aliases: ["x (twitter)", "twitter"],
    availability: "comingSoon",
  },
  // Twitter is an alias of X. Keep the legacy token resolvable without
  // rendering a second source card for the same source.
  {
    id: "reddit",
    displayName: "Reddit",
    brandDomain: "reddit.com",
    platformIds: ["reddit"],
    availability: "comingSoon",
  },
  {
    id: "facebook",
    displayName: "Facebook",
    brandDomain: "facebook.com",
    platformIds: ["facebook"],
    availability: "comingSoon",
  },
  {
    id: "google",
    displayName: "Google",
    brandDomain: "google.com",
    platformIds: ["google"],
    availability: "comingSoon",
  },
  {
    id: "tiktok",
    displayName: "TikTok",
    brandDomain: "tiktok.com",
    platformIds: ["tiktok"],
    availability: "comingSoon",
  },
]

const PLATFORM_REGISTRY_ADDITIONAL: PlatformRegistryEntry[] = [
  {
    id: "icloud_notes",
    displayName: "iCloud Notes",
    brandDomain: "icloud.com",
    iconKey: "icloud_notes",
    platformIds: ["icloud-notes-playwright", "icloud_notes"],
    aliases: ["icloud notes"],
    showInConnectList: true,
    ingestScope: "icloud_notes.notes",
  },
]

export const PLATFORM_REGISTRY: PlatformRegistryEntry[] = [
  ...PLATFORM_REGISTRY_GENERATED,
  ...PLATFORM_REGISTRY_ADDITIONAL,
  ...PLATFORM_REGISTRY_COMING_SOON,
]
