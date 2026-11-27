// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as React from "react";
import { redirect } from "next/navigation";
Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module(new URL("./token-data.ts", import.meta.url).href, { namedExports: { loadTokenGroups: async () => redirect("/owner/login") } });
mock.module(new URL("./actions.ts", import.meta.url).href, { namedExports: { issueOwnerTokenAction: async () => {}, renameOwnerTokenAction: async () => {}, revokeOwnerClientTokenAction: async () => {}, revokeOwnerTokenAction: async () => {} } });
mock.module(new URL("../../settings/owner-sessions-actions.ts", import.meta.url).href, { namedExports: { revokeOwnerBearerAction: async () => ({ ok: true }) } });
mock.module(new URL("../../components/recordroom-shell-with-palette.tsx", import.meta.url).href, { namedExports: { RecordroomShellWithPalette: ({ children }: { children: React.ReactNode }) => React.createElement("main", null, children) } });
test("an expired sign-in redirects rather than being converted to an inventory failure", async () => {
  const { default: Page } = await import("./page.tsx");
  await assert.rejects(Page({ searchParams: Promise.resolve({}) }), (error: unknown) => Boolean(error && typeof error === "object" && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")));
});
