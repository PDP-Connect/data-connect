// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isMissingManualUploadSetup } from "./manual-upload-setup-read.ts";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));

function refError(status: number, code: string): { bodyText: string; status: number } {
  return { bodyText: JSON.stringify({ error: { code, message: "x", type: "invalid_request_error" } }), status };
}

test("a connector without file import is treated as not found, not as a retryable fault", () => {
  // The server answers 409 manual_upload_unsupported for a connector that declares no import setup
  // (seen live for google-takeout); rethrowing it left the page on the root error boundary's skeleton.
  assert.equal(isMissingManualUploadSetup(refError(409, "manual_upload_unsupported")), true);
  assert.equal(isMissingManualUploadSetup({ status: 404 }), true);
});

test("other failures still reach the error boundary", () => {
  assert.equal(isMissingManualUploadSetup(refError(409, "conflict")), false);
  assert.equal(isMissingManualUploadSetup(refError(500, "manual_upload_unsupported")), false);
  assert.equal(isMissingManualUploadSetup({ bodyText: "not json", status: 409 }), false);
  assert.equal(isMissingManualUploadSetup(new Error("network")), false);
  assert.equal(isMissingManualUploadSetup(null), false);
});

test("the page sends a missing file-import setup to notFound", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, /err instanceof RefNotFoundError \|\| isMissingManualUploadSetup\(err\)\) \{\s*notFound\(\);/);
});
