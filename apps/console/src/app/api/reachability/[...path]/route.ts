// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The browser's way to the reference server's remote access API. A route handler, not a
// Server Action: Next.js runs one client's Server Actions one at a time, so the page's own
// polling made every Turn on request wait in line. Each fetch to this handler runs on its
// own. The owner's bearer stays on this server; the browser holds only its session cookie.
import { NextResponse } from "next/server";
import { isAllowedConsoleRequestHost } from "../../../../lib/console-host.ts";
import { readDashboardOwnerSession } from "../../../(console)/lib/owner-token.ts";
import { publicOrigin } from "../../../(console)/lib/same-origin-route.ts";
import { forwardReachability } from "../../../(console)/settings/reachability-forward.ts";
import { publicError } from "../../../(console)/settings/reachability-errors.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE = "/api/reachability";
const NO_STORE = { "Cache-Control": "no-store" };

/** A POST must come from this console's own pages: its Origin names the host the browser used. */
function fromThisConsole(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(publicOrigin(request)).host;
  } catch {
    return false;
  }
}

function reply(status: number, result: unknown): NextResponse {
  return NextResponse.json(result, { status, headers: NO_STORE });
}

async function handle(request: Request, post: boolean): Promise<NextResponse> {
  // The proxy's Host allowlist guards the pages; this handler is outside its matcher so the
  // address check at app/api/reachability/console-proof keeps answering for any host.
  if (!isAllowedConsoleRequestHost(request.headers.get("host") ?? new URL(request.url).host)) {
    return new NextResponse("Host not allowed", { status: 403 });
  }
  const url = new URL(request.url);
  // The path as the browser wrote it, still encoded: a draft id may hold characters a segment would lose.
  const path = `${url.pathname.slice(BASE.length)}${url.search}`;
  let body: Record<string, unknown> | undefined;
  if (post) {
    if (!fromThisConsole(request)) return reply(403, { ok: false, ...publicError("forbidden") });
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return reply(415, { ok: false, ...publicError("invalid_input") });
    }
    try {
      const parsed: unknown = await request.json();
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return reply(400, { ok: false, ...publicError("invalid_input") });
    }
  }
  try {
    if (!(await readDashboardOwnerSession())) {
      return reply(401, { ok: false, ...publicError("owner_session_required") });
    }
  } catch {
    return reply(502, { ok: false, ...publicError("service_unreachable") });
  }
  try {
    const { status, result } = await forwardReachability(path, body, request.signal);
    return reply(status, result);
  } catch {
    // A path that is not in the remote access family. Nothing was forwarded.
    return reply(400, { ok: false, ...publicError("invalid_input") });
  }
}

export function GET(request: Request): Promise<NextResponse> {
  return handle(request, false);
}

export function POST(request: Request): Promise<NextResponse> {
  return handle(request, true);
}
