// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getRunEffectiveAuthorityEvent } from "../lib/spine.ts";

// One durable read behind both owner API families; no manifest reconstruction
// and no timeline-window dependency. Legacy runs have no authority attestation.
export async function readRunEffectiveAuthority(runId: string): Promise<Readonly<Record<string, unknown>> | null> {
  const event = await getRunEffectiveAuthorityEvent(runId);
  const record = event?.data?.effective_authority;
  return record && typeof record === "object" && !Array.isArray(record)
    ? (record as Readonly<Record<string, unknown>>)
    : null;
}
