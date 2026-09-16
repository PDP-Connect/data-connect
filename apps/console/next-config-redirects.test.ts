// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "./next.config.mjs";

interface RedirectRule {
  destination: string;
  permanent?: boolean;
  source: string;
}

const TRAILING_SLASH_RE = /\/$/;

function matchRule(rule: RedirectRule, pathname: string): string | null {
  const { source, destination } = rule;

  if (source.endsWith("/:rest*")) {
    const prefix = source.slice(0, -"/:rest*".length);
    if (pathname === prefix) {
      return destination.replace("/:rest*", "").replace(":rest*", "") || "/";
    }
    if (pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length + 1);
      return destination.replace(":rest*", rest).replace(TRAILING_SLASH_RE, "") || "/";
    }
    return null;
  }

  return pathname === source ? destination : null;
}

function resolve(redirects: RedirectRule[], pathname: string) {
  for (const rule of redirects) {
    const destination = matchRule(rule, pathname);
    if (destination !== null) {
      return { destination, permanent: rule.permanent === true };
    }
  }
  return null;
}

test("configured redirects resolve correctly", async () => {
  assert.ok(nextConfig.redirects, "next.config.mjs must declare redirects()");
  const redirects = await nextConfig.redirects();
  assert.equal(resolve(redirects, "/favicon.ico")?.destination, "/brand/pdpp-favicon.svg");
});

test("configured reference rewrites resolve correctly", async () => {
  assert.ok(nextConfig.rewrites, "next.config.mjs must declare rewrites()");
  const rewrites = await nextConfig.rewrites();
  assert.ok(Array.isArray(rewrites), "next.config.mjs rewrites() must return an array");
  assert.deepEqual(
    rewrites.map(({ source, destination }) => ({ destination, source })),
    [
      {
        destination: "/well-known/oauth-authorization-server",
        source: "/.well-known/oauth-authorization-server",
      },
      {
        destination: "/well-known/oauth-protected-resource/:path*",
        source: "/.well-known/oauth-protected-resource/:path*",
      },
      {
        destination: "/well-known/oauth-protected-resource",
        source: "/.well-known/oauth-protected-resource",
      },
      {
        destination: "/well-known/skills/:path*",
        source: "/.well-known/skills/:path*",
      },
      {
        destination: "/llms.txt",
        source: "/.well-known/llms.txt",
      },
    ]
  );
});
