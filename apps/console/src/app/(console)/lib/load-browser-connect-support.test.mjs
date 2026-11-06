// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

let templates = [];
const source = mock.module(new URL("./rs-client.ts", import.meta.url).href, {
  namedExports: { listOwnerConnectorTemplates: () => Promise.resolve(templates) },
});
after(() => source.restore());
const { loadBrowserConnectSupport } = await import("./load-browser-connect-support.ts");

test("registered browser modality preserves existing-account repair without authorizing a new account", async () => {
  templates = [{ connector_id: "book-shelf", connector_modality: "browser_bound" }];
  assert.deepEqual(await loadBrowserConnectSupport("book-shelf"), { browserBound: true, canAddAccount: false });
  templates = [{ ...templates[0], browser_enrollment_artifact: { status: "invalid" } }];
  assert.deepEqual(await loadBrowserConnectSupport("book-shelf"), { browserBound: true, canAddAccount: false });
});

test("verified host evidence permits new browser enrollment while a missing source does not", async () => {
  templates = [
    {
      connector_id: "book-shelf",
      connector_modality: "browser_bound",
      browser_enrollment_artifact: {
        manifest: { runtime_requirements: { bindings: { browser: { required: true } } } },
        status: "verified",
        trust: "developer-local-unsigned",
      },
    },
  ];
  assert.deepEqual(await loadBrowserConnectSupport("book-shelf"), { browserBound: true, canAddAccount: true });
  templates = [];
  assert.deepEqual(await loadBrowserConnectSupport("book-shelf"), { browserBound: false, canAddAccount: false });
});

test("verified installed and developer-local artifacts authorize unknown keys without optional manifests", async () => {
  templates = [
    {
      connector_id: "goodreads404",
      connector_key: "goodreads404",
      browser_enrollment_artifact: {
        manifest: {
          connector_key: "goodreads404",
          runtime_requirements: { bindings: { browser: { required: true } } },
        },
        status: "verified",
        trust: "signed-installed",
      },
    },
    {
      connector_id: "new-local-bookshelf",
      connector_key: "new-local-bookshelf",
      browser_enrollment_artifact: {
        manifest: {
          connector_key: "new-local-bookshelf",
          runtime_requirements: { bindings: { browser: { required: true } } },
        },
        status: "verified",
        trust: "developer-local-unsigned",
      },
    },
  ];
  assert.deepEqual(await loadBrowserConnectSupport("goodreads404"), { browserBound: true, canAddAccount: true });
  assert.deepEqual(await loadBrowserConnectSupport("new-local-bookshelf"), {
    browserBound: true,
    canAddAccount: true,
  });
  // The mocked owner projection is the only source of connector metadata here;
  // optional bundled manifests are deliberately absent.
});
