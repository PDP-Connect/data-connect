// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** "1 record" / "2 records" / "1,204 records": the one count format, never a bare number. */
export function recordCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"}`;
}
