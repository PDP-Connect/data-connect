// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BindingControlError } from "../runtime/binding-control.ts";
import { newBrowserBindingApprovalExpiry } from "../server/browser-binding-lifetime.ts";
import {
  BrowserBindingRuntimeConfigurationError,
  readBrowserBindingRuntimeConfig,
} from "../server/browser-binding-runtime-config.ts";

test("normal startup resolves two distinct file-backed control roles without a human approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "binding-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const allocatorFile = join(root, "allocator-token");
  const authorizerFile = join(root, "authorizer-token");
  const configFile = join(root, "config.json");
  await writeFile(allocatorFile, `${"a".repeat(64)}\n`);
  await writeFile(authorizerFile, `${"b".repeat(64)}\r\n`);
  const config = {
    allocator: { credentialFile: allocatorFile, timeoutMs: 1000, url: "http://127.0.0.1:7331" },
    approvalMaxAgeMs: 86_400_000,
    authorizer: { credentialFile: authorizerFile, timeoutMs: 1000, url: "https://reference.invalid" },
    policyIdentity: "fixture-policy",
    version: 1,
  };
  await writeFile(configFile, JSON.stringify(config));
  assert.equal(await readBrowserBindingRuntimeConfig({}), null);
  const resolved = await readBrowserBindingRuntimeConfig({ PDPP_BROWSER_BINDING_CONFIG_FILE: configFile });
  assert.ok(resolved);
  assert.equal(resolved.allocator.credential, "a".repeat(64));
  assert.equal(resolved.authorizer.credential, "b".repeat(64));
  assert.equal(resolved.approvalMaxAgeMs, 86_400_000);
  assert.equal(Object.hasOwn(resolved, "approved"), false, "service setup must not contain an owner decision");

  const invalid = [
    { ...config, approvalMaxAgeMs: 0 },
    { ...config, approvalMaxAgeMs: Number.MAX_SAFE_INTEGER },
    { ...config, unknown: "not allowed" },
    { ...config, allocator: { ...config.allocator, credentialFile: "relative-secret" } },
    { ...config, allocator: { ...config.allocator, url: "http://docker-service:7331" } },
    { ...config, allocator: { ...config.allocator, url: "https://reference.invalid/private" } },
    { ...config, authorizer: { ...config.authorizer, credentialFile: allocatorFile } },
  ];
  await invalid.reduce(async (previous, value) => {
    await previous;
    await writeFile(configFile, JSON.stringify(value));
    await assert.rejects(
      readBrowserBindingRuntimeConfig({ PDPP_BROWSER_BINDING_CONFIG_FILE: configFile }),
      BrowserBindingRuntimeConfigurationError
    );
  }, Promise.resolve());
  const duplicate = JSON.stringify(config).replace('"version":1', '"version":1,"ver\\u0073ion":1');
  await writeFile(configFile, duplicate);
  await assert.rejects(
    readBrowserBindingRuntimeConfig({ PDPP_BROWSER_BINDING_CONFIG_FILE: configFile }),
    BrowserBindingRuntimeConfigurationError
  );
  await writeFile(configFile, " ".repeat(16_385));
  await assert.rejects(
    readBrowserBindingRuntimeConfig({ PDPP_BROWSER_BINDING_CONFIG_FILE: configFile }),
    BrowserBindingRuntimeConfigurationError
  );
  await writeFile(configFile, JSON.stringify({ ...config, allocator: { ...config.allocator, url: "secret-value" } }));
  await assert.rejects(readBrowserBindingRuntimeConfig({ PDPP_BROWSER_BINDING_CONFIG_FILE: configFile }), (error) => {
    assert.ok(error instanceof BrowserBindingRuntimeConfigurationError);
    assert.equal(error.message, "Browser binding runtime configuration is invalid");
    assert.equal(error.cause, undefined, "raw file/URL failures must not leak through error causes");
    return true;
  });
});

test("proposal age is independent of daemon uptime and legacy absolute deadlines keep their meaning", () => {
  const now = 1_700_000_000_000;
  assert.equal(newBrowserBindingApprovalExpiry({ approvalMaxAgeMs: 60_000 }, now), now + 60_000);
  assert.equal(newBrowserBindingApprovalExpiry({ approvalMaxAgeMs: 60_000 }, now + 120_000), now + 180_000);
  assert.equal(newBrowserBindingApprovalExpiry({ policyExpiresAt: now + 60_000 }, now), now + 60_000);
  assert.throws(
    () => newBrowserBindingApprovalExpiry({ policyExpiresAt: now + 60_000 }, now + 120_000),
    BindingControlError
  );
  assert.throws(() => newBrowserBindingApprovalExpiry({ approvalMaxAgeMs: 0 }, now), BindingControlError);
  assert.throws(
    () => newBrowserBindingApprovalExpiry({ approvalMaxAgeMs: Number.MAX_SAFE_INTEGER }, now),
    BindingControlError
  );
  const ambiguous = { approvalMaxAgeMs: 60_000, policyExpiresAt: now + 60_000 };
  assert.throws(
    () =>
      newBrowserBindingApprovalExpiry(
        ambiguous as unknown as Parameters<typeof newBrowserBindingApprovalExpiry>[0],
        now
      ),
    BindingControlError
  );
});
