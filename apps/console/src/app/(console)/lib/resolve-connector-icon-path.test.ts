// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConnectorIconFromManifestPath } from "./resolve-connector-icon-path.ts";

async function withManifestsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "connector-icons-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("resolves a valid relative-path SVG icon", async () => {
  await withManifestsDir(async (dir) => {
    await mkdir(join(dir, "icons"), { recursive: true });
    await writeFile(join(dir, "icons", "amazon.svg"), '<svg viewBox="0 0 24 24"><path d="M1 2" /></svg>');
    assert.deepEqual(await resolveConnectorIconFromManifestPath(dir, "icons/amazon.svg"), {
      kind: "inline_svg",
      svg: '<svg viewBox="0 0 24 24"><path d="M1 2" /></svg>',
    });
  });
});

test("returns null for a missing file", async () => {
  await withManifestsDir(async (dir) => {
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "icons/missing.svg"), null);
  });
});

test("returns null for a path-traversal attempt", async () => {
  await withManifestsDir(async (dir) => {
    const secretPath = join(dir, "..", "secret.svg");
    await writeFile(secretPath, "<svg><path d=\"M1 2\" /></svg>");
    try {
      assert.equal(await resolveConnectorIconFromManifestPath(dir, "../secret.svg"), null);
      assert.equal(await resolveConnectorIconFromManifestPath(dir, "icons/../../secret.svg"), null);
    } finally {
      await rm(secretPath, { force: true });
    }
  });
});

test("returns null for an absolute path escaping the manifests directory", async () => {
  await withManifestsDir(async (dir) => {
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "/etc/passwd"), null);
  });
});

test("returns null for non-SVG content", async () => {
  await withManifestsDir(async (dir) => {
    await writeFile(join(dir, "not-svg.svg"), "just some text, not markup");
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "not-svg.svg"), null);
  });
});

test("returns null for SVG content carrying a script element", async () => {
  await withManifestsDir(async (dir) => {
    await writeFile(join(dir, "malicious.svg"), "<svg><script>alert(1)</script></svg>");
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "malicious.svg"), null);
  });
});

test("returns null for SVG content carrying an event-handler attribute", async () => {
  await withManifestsDir(async (dir) => {
    await writeFile(join(dir, "onload.svg"), '<svg onload="alert(1)"><path d="M1 2" /></svg>');
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "onload.svg"), null);
  });
});

test("returns null for SVG content with an external reference", async () => {
  await withManifestsDir(async (dir) => {
    await writeFile(join(dir, "external.svg"), '<svg><image href="https://evil.test/x.png" /></svg>');
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "external.svg"), null);
  });
});

test("resolves a shipped-shape icon with aria-hidden and a fill color on the root", async () => {
  await withManifestsDir(async (dir) => {
    const svg = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M1 2" /></svg>';
    await writeFile(join(dir, "shipped.svg"), svg);
    assert.deepEqual(await resolveConnectorIconFromManifestPath(dir, "shipped.svg"), {
      kind: "inline_svg",
      svg,
    });
  });
});

test("returns null for an empty or blank path", async () => {
  await withManifestsDir(async (dir) => {
    assert.equal(await resolveConnectorIconFromManifestPath(dir, ""), null);
    assert.equal(await resolveConnectorIconFromManifestPath(dir, "   "), null);
  });
});
