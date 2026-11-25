// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function formatIntervalWords(seconds: number): string {
  if (seconds === 86_400) return "Every day";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `Every ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `Every ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
