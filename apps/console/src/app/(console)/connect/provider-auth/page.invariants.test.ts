// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}[connectorId]/page.tsx`;
const START_ROUTE_FILE = `${HERE}[connectorId]/start/route.ts`;
const OWNER_POST_FORM_RE =
  /<form action=\{`\/connect\/provider-auth\/\$\{encodeURIComponent\(connectorId\)\}\/start`\} method="post">/;
const AUTHORIZE_ACCOUNT_RE = /Continue to \{displayName\}/;
// The predicate itself is behavior-tested in provider-auth-support.test.ts.
const PROVIDER_SUPPORT_CHECK_RE = /if \(!supportsProviderAuth\(buildOwnerConnectorCatalog\(manifests, templates\), connectorId\)\) \{\s*notFound\(\);/;
const NOT_FOUND_RE = /notFound\(\)/;
const DASHBOARD_ACCESS_RE = /requireDashboardAccess\(path\)/;
const SAME_ORIGIN_RE = /originMatchesHost\(request\)/;
const INITIATE_PROVIDER_AUTH_RE = /initiateProviderAuthorization\(connectorId\)/;
const DEPLOYMENT_ROUTE_RE = /\/deployment/;

test("provider authorization uses a same-origin owner POST action", async () => {
  const [page, route] = await Promise.all([readFile(PAGE_FILE, "utf8"), readFile(START_ROUTE_FILE, "utf8")]);

  assert.match(page, OWNER_POST_FORM_RE);
  assert.match(page, AUTHORIZE_ACCOUNT_RE);
  assert.match(page, PROVIDER_SUPPORT_CHECK_RE);
  assert.match(page, NOT_FOUND_RE);
  assert.match(route, DASHBOARD_ACCESS_RE);
  assert.match(route, SAME_ORIGIN_RE);
  assert.match(route, INITIATE_PROVIDER_AUTH_RE);
  assert.doesNotMatch(route, DEPLOYMENT_ROUTE_RE);
});
