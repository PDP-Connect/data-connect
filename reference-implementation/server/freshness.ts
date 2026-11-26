// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ReferenceFreshness {
  captured_at?: string;
  last_attempted_at?: string;
  status: "current" | "stale" | "unknown";
}

export interface DeriveReferenceFreshnessInput {
  lastAttemptedAt?: string | null;
  lastAttemptStatus?: string | null;
  lastSuccessfulRunAt?: string | null;
  maximumStalenessSeconds?: number | null;
  now?: Date | number | string;
  recordLastUpdatedAt?: string | null;
}

function isoOrNull(value: Date | number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function timeOrNull(value: Date | number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isFailureStatus(status: string | null | undefined): boolean {
  return status === "failed" || status === "cancelled";
}

export function deriveReferenceFreshness(input: DeriveReferenceFreshnessInput): ReferenceFreshness {
  const nowTime = timeOrNull(input.now ?? new Date()) ?? Date.now();
  const usableTime = (value: string | null | undefined): number | null => {
    const time = timeOrNull(value);
    return time !== null && time <= nowTime ? time : null;
  };
  const lastSuccessfulTime = usableTime(input.lastSuccessfulRunAt);
  const lastAttemptedTime = usableTime(input.lastAttemptedAt);
  const capturedTime = lastSuccessfulTime ?? usableTime(input.recordLastUpdatedAt);
  const capturedAt = isoOrNull(capturedTime);
  const lastAttemptedAt = isoOrNull(lastAttemptedTime);
  const seconds = input.maximumStalenessSeconds;
  const policyMs = typeof seconds === "number" && seconds >= 0 ? seconds * 1000 : NaN;
  const maxStalenessMs = Number.isFinite(policyMs) ? policyMs : null;

  let status: ReferenceFreshness["status"] = "unknown";
  const latestAttemptFailedAfterSuccess =
    isFailureStatus(input.lastAttemptStatus) &&
    lastAttemptedTime !== null &&
    (lastSuccessfulTime === null || lastAttemptedTime >= lastSuccessfulTime);

  if (latestAttemptFailedAfterSuccess) {
    status = "stale";
  } else if (capturedTime !== null && maxStalenessMs !== null) {
    status = nowTime - capturedTime <= maxStalenessMs ? "current" : "stale";
  }

  const freshness: ReferenceFreshness = { status };
  if (capturedAt) {
    freshness.captured_at = capturedAt;
  }
  if (lastAttemptedAt) {
    freshness.last_attempted_at = lastAttemptedAt;
  }
  return freshness;
}
