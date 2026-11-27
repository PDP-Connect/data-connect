// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The count line over a records table. One page that holds everything reads "2 records";
 * a page number only appears when there is more than one page to tell apart.
 */
export function formatStreamPageCount(input: {
  filtered: boolean;
  hasMore: boolean;
  matchingCount: number | null;
  pageNumber: number;
  shown: number;
  totalHeld: number | null;
}): string | null {
  const onlyPage = input.pageNumber === 1 && !input.hasMore;
  if (onlyPage && !input.filtered) return null;
  if (onlyPage) {
    const noun = input.filtered ? "matching record" : "record";
    return `${input.shown.toLocaleString()} ${noun}${input.shown === 1 ? "" : "s"}`;
  }
  const pagePrefix = `Page ${input.pageNumber} · ${input.shown}`;
  if (input.filtered) {
    if (input.matchingCount !== null) {
      const matchingNoun = input.matchingCount === 1 ? "matching record" : "matching records";
      const matchingPrefix = `${pagePrefix} of ${input.matchingCount.toLocaleString()} ${matchingNoun}`;
      return input.totalHeld === null
        ? matchingPrefix
        : `${matchingPrefix} · ${input.totalHeld.toLocaleString()} total held`;
    }
    const filteredPrefix = `${pagePrefix} for current filters`;
    return input.totalHeld === null
      ? `${filteredPrefix}${input.hasMore ? " · more available" : ""}`
      : `${filteredPrefix} · ${input.totalHeld.toLocaleString()} total held`;
  }
  return input.totalHeld === null
    ? `${pagePrefix}${input.hasMore ? " · more available" : ""}`
    : `${pagePrefix} of ${input.totalHeld.toLocaleString()}`;
}
