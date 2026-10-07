// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Answers the desktop supervisor's origin-proof challenge
// (`probe_public_origin` in `src-tauri/src/unified.rs`).
//
// The supervisor fetches `<public origin>/api/origin-proof?challenge=<hex>`
// and accepts the answer only if it is HMAC-SHA256(key, challenge) under the
// per-process key it gave this console as `PDPP_ORIGIN_PROOF_KEY`. A correct
// answer shows that the public origin reaches THIS console, not a stale port,
// the reference server, or another DataConnect. That is something no
// provider status and no `--url` flag can show.
//
// Deliberately served here and never proxied to the reference server: a
// route that reaches the bare RI port is one of the misroutes this must
// catch. Unauthenticated because the probe carries no owner session, and
// safe because the answer holds nothing: the key never leaves this process,
// and an HMAC of a caller-chosen challenge reveals nothing about it. A
// console started without a key (anything but the desktop supervisor) has
// nothing to prove and answers 404.

import { createHmac } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHALLENGE_PATTERN = /^[0-9a-f]{32}$/;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function GET(request: Request): Response {
  const key = process.env.PDPP_ORIGIN_PROOF_KEY?.trim();
  if (!key) {
    return new Response("Not Found", { headers: NO_STORE_HEADERS, status: 404 });
  }
  const challenge = new URL(request.url).searchParams.get("challenge") ?? "";
  if (!CHALLENGE_PATTERN.test(challenge)) {
    return new Response("Bad Request", { headers: NO_STORE_HEADERS, status: 400 });
  }
  const proof = createHmac("sha256", key).update(challenge).digest("hex");
  return new Response(proof, {
    headers: { ...NO_STORE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    status: 200,
  });
}
