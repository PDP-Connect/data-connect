// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runAuthority } from "./authority.ts";
import type { Manifest } from "./inventory.ts";

const authorityPath = fileURLToPath(new URL("./authority.ts", import.meta.url));

test("protocol-error exit-code coercion happens before the transcript end event is written", async () => {
	const source = await readFile(authorityPath, "utf8");
	const coercionIndex = source.indexOf("observed.exit_code ||= 1;");
	const endEventIndex = source.indexOf('event: "end"', coercionIndex);
	assert.notEqual(coercionIndex, -1);
	assert.notEqual(endEventIndex, -1);
	assert.ok(coercionIndex < endEventIndex);
});

test("an exit-0 suite with no structured node-test events records the coerced exit code before transcript closure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-authority-receipt-binding-"));
	try {
		await mkdir(join(root, "test"));
		await writeFile(
			join(root, "test", "noop.test.js"),
			"export const selected = true;\n",
		);
		const manifest: Manifest = {
			schema: "pdpp.test-accounting/v3",
			inventory_base_sha: "0000000000000000000000000000000000000000",
			suites: [
				{
					id: "receipt-binding-fixture",
					cwd: ".",
					loader: "node-test",
					authority_argument: null,
					execution: "direct",
					command: [process.execPath, "-e", "process.exit(0)"],
					profiles: [{ id: "default", required: true, skip_reasons: {} }],
					include: ["test/*.test.js"],
				},
			],
			exclusions: [],
		};
		await writeFile(
			join(root, "test-accounting.manifest.json"),
			`${JSON.stringify(manifest)}\n`,
		);
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "fixture@example.test"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
		manifest.inventory_base_sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		await writeFile(
			join(root, "test-accounting.manifest.json"),
			`${JSON.stringify(manifest)}\n`,
		);
		execFileSync("git", ["add", "test-accounting.manifest.json"], {
			cwd: root,
		});
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		await assert.rejects(
			runAuthority({ root, suites: ["receipt-binding-fixture"] }),
			/receipt-binding-fixture\/default did not pass/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
