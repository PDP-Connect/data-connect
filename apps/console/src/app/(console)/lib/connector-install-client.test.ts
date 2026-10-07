// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { isTransientConnectorInstallCatalogError } from "./connector-install-transient.ts";

test("connector install snapshot softens only transient catalog busy failures", () => {
  assert.equal(
    isTransientConnectorInstallCatalogError(
      {
        body: "Another connector installation is in progress.",
        path: "/v1/owner/connector-install/catalog",
        status: 500,
      }
    ),
    true
  );
  assert.equal(
    isTransientConnectorInstallCatalogError(
      {
        body: "Another connector catalog refresh is in progress.",
        path: "/v1/owner/connector-install/catalog",
        status: 500,
      }
    ),
    true
  );
  assert.equal(
    isTransientConnectorInstallCatalogError(
      {
        body: "Another connector installation is in progress.",
        path: "/v1/owner/connector-install/status",
        status: 500,
      }
    ),
    false
  );
  assert.equal(
    isTransientConnectorInstallCatalogError(
      {
        body: "Active connector bytes failed integrity verification.",
        path: "/v1/owner/connector-install/catalog",
        status: 500,
      }
    ),
    false
  );
});
