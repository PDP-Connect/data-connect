// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

let templates = [];
let optionalManifests = [];
const rsClient = mock.module(new URL("../../../lib/rs-client.ts", import.meta.url).href, {
  namedExports: {
    listConnectorManifests: () => Promise.resolve(optionalManifests),
    listOwnerConnectorTemplates: () => Promise.resolve(templates),
  },
});
const refClient = mock.module(new URL("../../../lib/ref-client.ts", import.meta.url).href, {
  namedExports: { getStaticSecretSetup: () => Promise.resolve(null) },
});
const liveChannel = mock.module(new URL("../../../lib/live-channel-actions.ts", import.meta.url).href, {
  namedExports: { mintLiveChannelAction: () => Promise.resolve({ eventsPath: "/_ref/owner-live/test" }) },
});
after(() => {
  liveChannel.restore();
  rsClient.restore();
  refClient.restore();
});

const { default: page } = await import("./page.tsx");

function descendants(value, output = []) {
  if (Array.isArray(value)) {
    for (const child of value) {
      descendants(child, output);
    }
  } else if (value && typeof value === "object" && "props" in value) {
    output.push(value);
    descendants(value.props.children, output);
  }
  return output;
}

test("post-deploy unknown browser artifacts return account setup; absent artifact stays denied", async (t) => {
  const assertPageSetup = async (connectorKey, trust) => {
    templates = [
      {
        connector_id: connectorKey,
        connector_key: connectorKey,
        browser_enrollment_artifact: {
          manifest: {
            connector_key: connectorKey,
            runtime_requirements: { bindings: { browser: { required: true } } },
          },
          status: "verified",
          trust,
        },
      },
    ];
    optionalManifests = [];
    const tree = await page({
      params: Promise.resolve({ connectorId: connectorKey }),
      searchParams: Promise.resolve({}),
    });
    const elements = descendants(tree);
    assert.ok(
      elements.some(
        (element) =>
          element.type === "form" && element.props.action === `/connect/browser-session/${connectorKey}/start`
      )
    );
    assert.ok(elements.some((element) => element.type === "button" && element.props.type === "submit"));
  };
  await t.test("goodreads404 (signed-installed)", () => assertPageSetup("goodreads404", "signed-installed"));
  await t.test("new-local-bookshelf (developer-local-unsigned)", () =>
    assertPageSetup("new-local-bookshelf", "developer-local-unsigned")
  );

  templates = [];
  await assert.rejects(
    page({ params: Promise.resolve({ connectorId: "goodreads404" }), searchParams: Promise.resolve({}) }),
    (error) => error?.message === "NEXT_HTTP_ERROR_FALLBACK;404"
  );
});
