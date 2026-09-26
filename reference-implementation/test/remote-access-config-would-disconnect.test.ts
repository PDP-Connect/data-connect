// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `wouldDisconnectRemoteOwner`'s branching, tested at the function level
 * rather than through the HTTP route (owner-remote-access-route.test.ts
 * covers that layer, including that a loopback request never gets refused
 * regardless of what this function decides): every posture/provider/
 * credential combination this decision actually branches on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  offRemoteAccessConfig,
  wouldDisconnectRemoteOwner,
  type RemoteAccessConfig,
} from "../server/remote-access-config.ts";

const CLOUDFLARE_CURRENT: RemoteAccessConfig = {
  cloudflare_tunnel: { hostname: "vault.example.com" },
  fields: {
    PDPP_BIND_HOST: "127.0.0.1",
    PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
    PDPP_TRUSTED_HOSTS: "vault.example.com",
    PDPP_TRUSTED_PROXIES: "",
  },
  posture: "public_url",
  provider: "cloudflare_tunnel",
};

test("no risk when there was no remote tunnel in the first place (posture was off)", () => {
  assert.equal(
    wouldDisconnectRemoteOwner(offRemoteAccessConfig(), CLOUDFLARE_CURRENT, true),
    false
  );
});

test("risky: leaving public_url entirely", () => {
  const next: RemoteAccessConfig = { ...offRemoteAccessConfig(), posture: "off" };
  assert.equal(wouldDisconnectRemoteOwner(CLOUDFLARE_CURRENT, next, false), true);
});

test("risky: switching provider, even with no new credential submitted", () => {
  const next: RemoteAccessConfig = {
    fields: offRemoteAccessConfig().fields,
    ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
    posture: "public_url",
    provider: "ngrok",
  };
  assert.equal(wouldDisconnectRemoteOwner(CLOUDFLARE_CURRENT, next, false), true);
});

test("risky: any submitted credential for the SAME provider and hostname, since a fresh token could still be wrong", () => {
  assert.equal(
    wouldDisconnectRemoteOwner(CLOUDFLARE_CURRENT, CLOUDFLARE_CURRENT, true),
    true
  );
});

test("NOT risky: identical provider, identical hostname, no new credential submitted", () => {
  // Only re-pinning console_port, for example -- the config watcher would
  // not even restart the stack for an unchanged provider/hostname pair.
  const next: RemoteAccessConfig = { ...CLOUDFLARE_CURRENT, console_port: 4310 };
  assert.equal(wouldDisconnectRemoteOwner(CLOUDFLARE_CURRENT, next, false), false);
});

test("risky: changing the Cloudflare hostname, even with no credential resubmitted", () => {
  const next: RemoteAccessConfig = {
    ...CLOUDFLARE_CURRENT,
    cloudflare_tunnel: { hostname: "different.example.com" },
  };
  assert.equal(wouldDisconnectRemoteOwner(CLOUDFLARE_CURRENT, next, false), true);
});

test("risky: changing the ngrok reserved domain, even with no credential resubmitted", () => {
  const current: RemoteAccessConfig = {
    fields: offRemoteAccessConfig().fields,
    ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: "old.ngrok.app" },
    posture: "public_url",
    provider: "ngrok",
  };
  const next: RemoteAccessConfig = {
    ...current,
    ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: "new.ngrok.app" },
  };
  assert.equal(wouldDisconnectRemoteOwner(current, next, false), true);
});

test("risky: changing the user_supplied_origin host, even with no credential concept for this provider", () => {
  const current: RemoteAccessConfig = {
    fields: {
      PDPP_BIND_HOST: "127.0.0.1",
      PDPP_REFERENCE_ORIGIN: "https://old.example.com",
      PDPP_TRUSTED_HOSTS: "old.example.com",
      PDPP_TRUSTED_PROXIES: "",
    },
    posture: "public_url",
    provider: "user_supplied_origin",
  };
  const next: RemoteAccessConfig = {
    ...current,
    fields: { ...current.fields, PDPP_REFERENCE_ORIGIN: "https://new.example.com" },
  };
  assert.equal(wouldDisconnectRemoteOwner(current, next, false), true);
});

test("NOT risky: resubmitting the identical user_supplied_origin config", () => {
  const current: RemoteAccessConfig = {
    fields: {
      PDPP_BIND_HOST: "127.0.0.1",
      PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
      PDPP_TRUSTED_HOSTS: "vault.example.com",
      PDPP_TRUSTED_PROXIES: "",
    },
    posture: "public_url",
    provider: "user_supplied_origin",
  };
  assert.equal(wouldDisconnectRemoteOwner(current, current, false), false);
});
