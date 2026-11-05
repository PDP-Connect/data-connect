// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Transport-byte budget for paged list routes.
 *
 * The client repeats the whole request on every continuation, and Node answers
 * HTTP 431 once the request line plus headers pass the server's header limit
 * (16,384 bytes by default). A route that pages must therefore know, before it
 * reads a page, that the continuation will fit.
 *
 * The check measures the request as it arrived (target and headers, in the
 * client's own encoding, cookies included) instead of predicting its size from
 * decoded query values: percent-encoded parameter names, escaped characters
 * and header size all change the real size. The cursor is the one part that
 * does not exist yet, so the check reserves its worst case: the longest cursor
 * the server can issue, with every character percent-encoded and the parameter
 * name percent-encoded too. The request is measured with its current cursor
 * removed, so page 1 and every later page get the same answer and a walk that
 * starts cannot be stranded part way by its own cursor.
 *
 * What this does not do:
 * - It assumes the continuation carries the same headers. {@link CONTINUATION_HEADER_SLACK_BYTES}
 *   absorbs small drift, such as a rotated cookie.
 * - It does not know the limit of a proxy in front of the server. A client must
 *   still handle a 431 or a refusal by degrading, not by assuming success.
 * - It measures HTTP/1.x. Another protocol version is refused, not guessed at.
 */

import { maxHeaderSize as defaultMaxHeaderSize } from "node:http";

export const CONTINUATION_HEADER_SLACK_BYTES = 512;

const CURSOR_PARAM = "cursor";
/** `&` + `cursor` with every character percent-encoded + `=`. */
const CURSOR_PARAM_NAME_AND_PUNCTUATION_BYTES = 1 + CURSOR_PARAM.length * 3 + 1;
const PERCENT_ENCODED_BYTES_PER_CHARACTER = 3;

export interface WireRequest {
  readonly httpVersion?: string;
  readonly method?: string;
  readonly rawHeaders?: readonly string[];
  /** The listening server; its `maxHeaderSize` is the limit that applies. */
  readonly socket?: { readonly server?: { readonly maxHeaderSize?: number } };
  readonly url?: string;
}

export interface ContinuationMeasurement {
  readonly fits: boolean;
  /** Header lines the request carries, in bytes. */
  readonly headerBytes: number;
  /** The server's header limit. */
  readonly limit: number;
  /** Bytes reserved for the cursor parameter of the next request. */
  readonly reserveBytes: number;
  /** Request line (without any cursor parameter) plus the blank line, in bytes. */
  readonly targetBytes: number;
}

function withoutCursorParam(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) {
    return url;
  }
  const kept = url
    .slice(queryStart + 1)
    .split("&")
    .filter((pair) => {
      const rawName = pair.split("=", 1)[0] ?? "";
      try {
        return decodeURIComponent(rawName.replaceAll("+", " ")) !== CURSOR_PARAM;
      } catch {
        return true;
      }
    });
  return kept.length > 0 ? `${url.slice(0, queryStart)}?${kept.join("&")}` : url.slice(0, queryStart);
}

/**
 * Measure whether the request that follows this one (the same request with a
 * cursor of up to `cursorMaxLength` characters) stays under the header limit.
 *
 * Throws when the request cannot be measured. A route that cannot measure must
 * not issue a cursor, so the caller treats this as a server error.
 */
export function measureContinuation(options: {
  readonly cursorMaxLength: number;
  readonly request: WireRequest | undefined;
}): ContinuationMeasurement {
  const { cursorMaxLength, request } = options;
  if (!(request?.rawHeaders && request.url !== undefined)) {
    throw new Error("continuation size cannot be measured: the raw request is unavailable");
  }
  if (!request.httpVersion?.startsWith("1.")) {
    throw new Error(`continuation size cannot be measured for HTTP ${request.httpVersion ?? "(unknown version)"}`);
  }
  const targetBytes = Buffer.byteLength(`${request.method ?? "GET"} ${withoutCursorParam(request.url)} HTTP/1.1\r\n\r\n`);
  let headerBytes = 0;
  for (let i = 0; i + 1 < request.rawHeaders.length; i += 2) {
    headerBytes += Buffer.byteLength(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`);
  }
  const reserveBytes =
    CURSOR_PARAM_NAME_AND_PUNCTUATION_BYTES + cursorMaxLength * PERCENT_ENCODED_BYTES_PER_CHARACTER;
  const limit = request.socket?.server?.maxHeaderSize ?? defaultMaxHeaderSize;
  return {
    fits: targetBytes + headerBytes + reserveBytes + CONTINUATION_HEADER_SLACK_BYTES <= limit,
    headerBytes,
    limit,
    reserveBytes,
    targetBytes,
  };
}
