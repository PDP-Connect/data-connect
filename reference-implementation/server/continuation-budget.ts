// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Transport-byte budget for paged list routes.
 *
 * The client repeats the whole request on every continuation, and Node answers
 * HTTP 431 once the request line plus headers pass its header limit (16,384
 * bytes by default). A page that issues a cursor therefore has to check that
 * the continuation will fit. This module measures the request as it arrived on
 * the wire (target and headers, in the client's own encoding, cookies included)
 * rather than predicting its size from decoded query values: percent-encoded
 * parameter names, escaped characters and header size all change the real size.
 *
 * Limits of the check: it compares against Node's header limit for this
 * process and assumes the continuation carries the same headers, with
 * {@link CONTINUATION_HEADER_SLACK_BYTES} of room for drift (for example a
 * rotated cookie). It does not know a proxy's own, possibly smaller, limit.
 */

import { maxHeaderSize } from "node:http";

export const CONTINUATION_HEADER_SLACK_BYTES = 512;

export interface WireRequest {
  readonly method?: string;
  readonly rawHeaders?: readonly string[];
  readonly url?: string;
}

/** Bytes Node counts against its header limit: request line, header lines and the blank line. */
export function wireRequestBytes(raw: WireRequest): number {
  let bytes = Buffer.byteLength(`${raw.method ?? "GET"} ${raw.url ?? ""} HTTP/1.1\r\n\r\n`);
  const headers = raw.rawHeaders ?? [];
  for (let i = 0; i + 1 < headers.length; i += 2) {
    bytes += Buffer.byteLength(`${headers[i]}: ${headers[i + 1]}\r\n`);
  }
  return bytes;
}

/**
 * Whether the request that follows this page, the same request with the cursor
 * added or replaced, stays under the header limit.
 */
export function continuationFits(options: {
  readonly currentCursor: string | undefined;
  readonly nextCursor: string;
  readonly request: WireRequest;
  readonly maxHeaderBytes?: number;
}): boolean {
  const delta = options.currentCursor
    ? options.nextCursor.length - options.currentCursor.length
    : "&cursor=".length + options.nextCursor.length;
  return (
    wireRequestBytes(options.request) + delta + CONTINUATION_HEADER_SLACK_BYTES <=
    (options.maxHeaderBytes ?? maxHeaderSize)
  );
}
