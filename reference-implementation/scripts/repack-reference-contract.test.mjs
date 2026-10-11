// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const riRoot = resolve(scriptDir, "..");
const repoRoot = resolve(riRoot, "..");
const sourceRoot = process.env.PDPP_REFERENCE_CONTRACT_SOURCE;
const outputRoot = process.env.PDPP_REFERENCE_CONTRACT_OUTPUT;
const archivePath = join(
	riRoot,
	"vendor/pdpp-reference-contract-0.1.0-proto.1.tgz",
);
const expectedArchiveSha256 =
	"0f9534e5b6c7a8d2fe81a1806ed0aeecce9c9dabd17b1e9f7bb472cda7d9a023";
const sourceCommit = "3b05c1b1e4db56c9cb2820e5bae570d6d3a73024";
const sourcePackagePath = "packages/reference-contract";

function listFiles(root) {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) =>
			relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
		)
		.sort();
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sourceGit(source, args) {
	return execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
}

test("repacking the signed PDPP reference contract reproduces the committed archive", {
	skip:
		sourceRoot && outputRoot
			? false
			: "Set PDPP_REFERENCE_CONTRACT_SOURCE and PDPP_REFERENCE_CONTRACT_OUTPUT to opt in; no network checkout is performed.",
}, (t) => {
	const source = resolve(sourceRoot);
	const output = resolve(outputRoot);
	assert.equal(
		sourceGit(source, ["rev-parse", "HEAD"]),
		sourceCommit,
		"source checkout must be the pinned commit",
	);
	execFileSync("git", ["verify-commit", sourceCommit], {
		cwd: source,
		stdio: "ignore",
	});
	assert.equal(
		sourceGit(source, ["show", "-s", "--format=%G?", sourceCommit]),
		"G",
		"pinned commit must have a valid signature",
	);

	const lock = readFileSync(join(source, "pnpm-lock.yaml"), "utf8");
	assert.match(
		lock,
		/^ {2}typescript@7\.0\.2:$/m,
		"source lock must pin TypeScript 7.0.2",
	);
	assert.match(lock, /^ {2}ajv@8\.20\.0:$/m, "source lock must pin AJV 8.20.0");

	const scriptPath = join(scriptDir, "repack-reference-contract.mjs");
	execFileSync(
		process.execPath,
		[scriptPath, "--source", source, "--output", output],
		{
			cwd: repoRoot,
			stdio: "inherit",
		},
	);

	const receipt = JSON.parse(
		readFileSync(join(output, "receipt.json"), "utf8"),
	);
	assert.equal(receipt.sourceCommit, sourceCommit);
	assert.equal(receipt.signatureVerified, true);
	assert.equal(receipt.versions.typescript, "7.0.2");
	assert.equal(receipt.versions.ajv, "8.20.0");
	assert.equal(typeof receipt.versions.node, "string");
	assert.equal(typeof receipt.versions.npm, "string");
	assert.equal(
		receipt.repackCount,
		2,
		"the script must prove two independent packs agree",
	);
	assert.equal(receipt.firstSha256, receipt.secondSha256);

	const resultArchive = resolve(output, receipt.archive);
	const archiveBytes = readFileSync(resultArchive);
	assert.equal(
		sha256(archiveBytes),
		expectedArchiveSha256,
		"repacked tarball digest must match the committed archive",
	);
	assert.equal(
		receipt.activeArchiveSha256,
		expectedArchiveSha256,
		"helper must compare with active SHA256SUMS",
	);
	assert.equal(receipt.sha256, expectedArchiveSha256);

	const compareRoot = mkdtempSync(
		join(tmpdir(), "reference-contract-repack-oracle-"),
	);
	t.after(() => rmSync(compareRoot, { force: true, recursive: true }));
	const expectedRoot = join(compareRoot, "expected");
	const actualRoot = join(compareRoot, "actual");
	mkdirSync(expectedRoot, { recursive: true });
	mkdirSync(actualRoot, { recursive: true });
	execFileSync("tar", ["-xzf", archivePath, "-C", expectedRoot]);
	execFileSync("tar", ["-xzf", resultArchive, "-C", actualRoot]);

	const expectedPackage = join(expectedRoot, "package");
	const actualPackage = join(actualRoot, "package");
	const expectedSources = listFiles(join(expectedPackage, "src"));
	const expectedCompiled = listFiles(join(expectedPackage, "dist"));
	assert.equal(expectedSources.length, 18);
	assert.equal(expectedCompiled.length, 36);
	assert.deepEqual(listFiles(join(actualPackage, "src")), expectedSources);
	assert.deepEqual(listFiles(join(actualPackage, "dist")), expectedCompiled);
	for (const file of expectedSources) {
		assert.deepEqual(
			readFileSync(join(actualPackage, "src", file)),
			readFileSync(join(expectedPackage, "src", file)),
			`source output differs from committed archive: ${file}`,
		);
		assert.deepEqual(
			readFileSync(join(actualPackage, "src", file)),
			readFileSync(join(source, sourcePackagePath, "src", file)),
			`source archive differs from pinned checkout: ${file}`,
		);
	}
	for (const file of expectedCompiled) {
		assert.deepEqual(
			readFileSync(join(actualPackage, "dist", file)),
			readFileSync(join(expectedPackage, "dist", file)),
			`compiled output differs from committed archive: ${file}`,
		);
	}
});
