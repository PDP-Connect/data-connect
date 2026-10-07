// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Topics on the owner live-invalidation channel (`routes/owner-live.ts`).
 * The console imports this list, so a topic it subscribes to must exist
 * here, and `registerDefaultLiveTopics` must give each one a revision.
 * No imports: the console loads this from client components.
 */
export const LIVE_TOPICS = ["desktop.autostart", "desktop.app-config", "remote-access"] as const

export type LiveTopic = (typeof LIVE_TOPICS)[number]
