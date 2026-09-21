// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the login-attempt throttle in `owner-login-rate-limit.ts`.
 * Pure module, no HTTP server needed — see `owner-auth.test.ts` for the
 * end-to-end wiring test against `POST /owner/login`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createOwnerLoginRateLimiter, type OwnerLoginRateLimitRequest } from "../server/owner-login-rate-limit.ts";

function remoteReq(ip = "203.0.113.7"): OwnerLoginRateLimitRequest {
  return { headers: { host: "owner.example-tunnel.dev" }, ip };
}

function localReq(ip = "127.0.0.1"): OwnerLoginRateLimitRequest {
  // `host` is deliberately NOT what makes this "local" -- classification is
  // by the connection's actual source IP (see owner-login-rate-limit.ts),
  // since `Host` is attacker-controlled on every incoming request. A
  // hostname is still included here to prove that: see the spoofed-Host
  // test below, which sends this same hostname from a remote IP and expects
  // it to be throttled at the strict ceiling anyway.
  return { headers: { host: "localhost:5180" }, ip };
}

test("owner login rate limit: remote caller is throttled after max attempts within the window", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 3, maxLocal: 100, windowMs: 60_000 });
  const req = remoteReq();
  assert.equal(limiter.check(req), null, "attempt 1 allowed");
  assert.equal(limiter.check(req), null, "attempt 2 allowed");
  assert.equal(limiter.check(req), null, "attempt 3 allowed");
  const retryAfter = limiter.check(req);
  assert.ok(typeof retryAfter === "number" && retryAfter > 0, "attempt 4 is throttled with a positive Retry-After");
});

test("owner login rate limit: the block self-clears once the window elapses (never a permanent lockout)", async () => {
  const limiter = createOwnerLoginRateLimiter({ max: 1, maxLocal: 100, windowMs: 50 });
  const req = remoteReq();
  assert.equal(limiter.check(req), null, "first attempt allowed");
  assert.ok(limiter.check(req), "second attempt throttled");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(limiter.check(req), null, "window elapsed — attempt allowed again with no operator action");
});

test("owner login rate limit: a correct password clears the throttle for that key immediately", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 2, maxLocal: 100, windowMs: 60_000 });
  const req = remoteReq();
  assert.equal(limiter.check(req), null);
  assert.equal(limiter.check(req), null);
  assert.ok(limiter.check(req), "third attempt throttled before success");
  limiter.recordSuccess(req);
  assert.equal(
    limiter.check(req),
    null,
    "legitimate owner is not left waiting out the rest of the window after signing in"
  );
});

test("owner login rate limit: local/private-network callers get a looser threshold than remote callers", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 2, maxLocal: 10, windowMs: 60_000 });
  const req = localReq();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(limiter.check(req), null, `local attempt ${i + 1} allowed under maxLocal`);
  }
  assert.ok(limiter.check(req), "local caller is still eventually throttled, just at a higher ceiling");
});

test("owner login rate limit: distinguishes local from remote by actual source IP, never by the declared Host header", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 1, maxLocal: 5, windowMs: 60_000 });
  const remoteIp = "198.51.100.9";
  const remote = remoteReq(remoteIp);
  // Same remote IP, but with a `localhost` Host header -- exactly what a
  // remote attacker over the public tunnel could send to try to qualify for
  // maxLocal. `Host` must be ignored for this classification: the request
  // is still throttled at the strict `max` ceiling because the connection's
  // real source IP is not a private-network address.
  const spoofedHost: OwnerLoginRateLimitRequest = { headers: { host: "localhost:5180" }, ip: remoteIp };
  assert.equal(limiter.check(remote), null, "remote attempt 1 allowed");
  assert.ok(
    limiter.check(spoofedHost),
    "a spoofed 'Host: localhost' header from a real remote IP does not grant the loose maxLocal ceiling"
  );
});

test("owner login rate limit: a genuinely local source IP gets maxLocal regardless of the declared Host header", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 1, maxLocal: 5, windowMs: 60_000 });
  // Real loopback IP, but with a Host header that looks like a public
  // tunnel hostname -- classification must still follow the actual source
  // IP, not the declared Host, in both directions.
  const req: OwnerLoginRateLimitRequest = { headers: { host: "owner.example-tunnel.dev" }, ip: "127.0.0.1" };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check(req), null, `local-IP attempt ${i + 1} allowed under maxLocal`);
  }
  assert.ok(limiter.check(req), "local-IP caller is still eventually throttled, just at the looser ceiling");
});

test("owner login rate limit: different source IPs are tracked independently", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 1, maxLocal: 100, windowMs: 60_000 });
  const attacker = remoteReq("198.51.100.1");
  const owner = remoteReq("198.51.100.2");
  assert.equal(limiter.check(attacker), null);
  assert.ok(limiter.check(attacker), "attacker IP throttled");
  assert.equal(limiter.check(owner), null, "a different remote IP is unaffected by another IP's throttle");
});

test("owner login rate limit: falls back to socket/connection remoteAddress when req.ip is absent", () => {
  const limiter = createOwnerLoginRateLimiter({ max: 1, maxLocal: 100, windowMs: 60_000 });
  const req: OwnerLoginRateLimitRequest = {
    headers: { host: "owner.example-tunnel.dev" },
    socket: { remoteAddress: "203.0.113.55" },
  };
  assert.equal(limiter.check(req), null);
  assert.ok(limiter.check(req), "second attempt from the same socket-derived key is throttled");
});
