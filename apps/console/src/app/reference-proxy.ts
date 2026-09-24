// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { isIP } from "node:net";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ReferenceTarget = "as" | "rs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const TRAILING_COLON_RE = /:$/;
const STARTUP_RETRY_AFTER_SECONDS = "2";
const ACTIVE_TUNNEL_PROVIDER_ENV = "PDPP_ACTIVE_TUNNEL_PROVIDER";
const CLOUDFLARE_TUNNEL_PROVIDER_ID = "cloudflare_tunnel";
const NGROK_PROVIDER_ID = "ngrok";
const OWNER_LOGIN_TUNNEL_CLIENT_IP_HEADER = "x-pdpp-owner-login-tunnel-client-ip";

interface CatchAllRouteContext {
  params: Promise<{
    path?: string[];
  }>;
}

function referenceBaseUrl(target: ReferenceTarget): string {
  const configured = target === "as" ? process.env.PDPP_AS_URL : process.env.PDPP_RS_URL;
  if (configured?.trim()) {
    return configured;
  }
  return target === "as" ? "http://localhost:7662" : "http://localhost:7663";
}

function forwardedProto(request: Request, url: URL): string {
  return request.headers.get("x-forwarded-proto") || url.protocol.replace(TRAILING_COLON_RE, "");
}

function activeTunnelProvider(): string {
  return process.env[ACTIVE_TUNNEL_PROVIDER_ENV]?.trim() ?? "";
}

function validIpLiteral(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || isIP(trimmed) === 0) {
    return null;
  }
  return trimmed;
}

function lastForwardedForEntry(value: string | null): string | null {
  const last = value
    ?.split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
    .at(-1);
  return validIpLiteral(last ?? null);
}

function tunnelClientIp(request: Request): string | null {
  switch (activeTunnelProvider()) {
    case CLOUDFLARE_TUNNEL_PROVIDER_ID:
      return validIpLiteral(request.headers.get("cf-connecting-ip"));
    case NGROK_PROVIDER_ID:
      // ngrok documents that it appends the real client IP to X-Forwarded-For.
      // Earlier entries can be client-supplied, so only the last entry is usable.
      return lastForwardedForEntry(request.headers.get("x-forwarded-for"));
    default:
      return null;
  }
}

export function buildProxyHeaders(request: Request, url: URL, path: readonly string[] = []): Headers {
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  headers.delete(OWNER_LOGIN_TUNNEL_CLIENT_IP_HEADER);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-forwarded-host", request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host);
  headers.set("x-forwarded-proto", forwardedProto(request, url));
  headers.set("x-forwarded-for", request.headers.get("x-forwarded-for") || "127.0.0.1");
  if (path.join("/") === "owner/login") {
    const clientIp = tunnelClientIp(request);
    if (clientIp) {
      headers.set(OWNER_LOGIN_TUNNEL_CLIENT_IP_HEADER, clientIp);
    }
  }
  return headers;
}

function buildResponseHeaders(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    nextHeaders.delete(header);
  }
  // Undici may transparently decode upstream bodies. Avoid stale length/encoding
  // metadata on proxied responses.
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-encoding");
  return nextHeaders;
}

function referenceHasStarted(): boolean {
  const readyFile = process.env.PDPP_REFERENCE_READY_FILE?.trim();
  return !readyFile || existsSync(readyFile);
}

function acceptsHtml(request: Request): boolean {
  return request.headers.get("accept")?.toLowerCase().includes("text/html") ?? false;
}

function startupPage(target: ReferenceTarget): Response {
  const service = target === "as" ? "owner sign-in" : "data service";
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="refresh" content="2" />
<title>DataConnect is starting</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; background: Canvas; color: CanvasText; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; }
main { width: min(32rem, 100%); }
h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
p { line-height: 1.5; color: color-mix(in srgb, CanvasText 72%, Canvas); }
</style>
</head>
<body><main aria-live="polite">
<p>PDPP</p>
<h1>Starting up</h1>
<p>The ${service} is warming up. This page will retry automatically.</p>
</main></body>
</html>`;
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "retry-after": STARTUP_RETRY_AFTER_SECONDS,
    },
    status: 503,
  });
}

function unavailableResponse(request: Request, target: ReferenceTarget, error: unknown): Response {
  if (!referenceHasStarted()) {
    return acceptsHtml(request)
      ? startupPage(target)
      : Response.json(
          {
            error: {
              code: "reference_starting",
              message: "PDPP is still starting. Retry shortly.",
            },
          },
          {
            headers: { "retry-after": STARTUP_RETRY_AFTER_SECONDS },
            status: 503,
          }
        );
  }
  return Response.json(
    {
      error: {
        code: "reference_unreachable",
        detail: error instanceof Error ? error.message : String(error),
        message: `Cannot reach PDPP ${target.toUpperCase()} service.`,
      },
    },
    { status: 502 }
  );
}

function targetUrl(target: ReferenceTarget, path: readonly string[], requestUrl: URL): URL {
  const base = new URL(referenceBaseUrl(target));
  const encodedPath = path.map((part) => encodeURIComponent(part)).join("/");
  return new URL(`/${encodedPath}${requestUrl.search}`, base);
}

export async function proxyReferenceRequest(
  request: Request,
  target: ReferenceTarget,
  path: readonly string[]
): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const upstreamUrl = targetUrl(target, path, sourceUrl);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  try {
    const upstream = await fetch(upstreamUrl, {
      body,
      headers: buildProxyHeaders(request, sourceUrl, path),
      method,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      headers: buildResponseHeaders(upstream.headers),
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    return unavailableResponse(request, target, error);
  }
}

export async function proxyReferenceCatchAll(
  request: Request,
  target: ReferenceTarget,
  prefix: readonly string[],
  context: CatchAllRouteContext
): Promise<Response> {
  const { path = [] } = await context.params;
  return proxyReferenceRequest(request, target, [...prefix, ...path]);
}
