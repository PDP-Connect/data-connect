// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(
	dirname(fileURLToPath(import.meta.url)),
	"open-browser-stack-pr.sh",
);
const git = (cwd, ...args) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "bump-pr-"));
	const remote = join(dir, "remote.git");
	const work = join(dir, "work");
	const bin = join(dir, "bin");
	const ghLog = join(dir, "gh.log");
	git(dir, "init", "-q", "--bare", remote);
	git(dir, "init", "-q", "-b", "main", work);
	for (const f of [
		"package.json",
		"package-lock.json",
		"reference-implementation/package.json",
		"pdpp-runtime/package.json",
		"pdpp-runtime/package-lock.json",
		"playwright-runner/package.json",
		"playwright-runner/package-lock.json",
	]) {
		mkdirSync(dirname(join(work, f)), { recursive: true });
		writeFileSync(join(work, f), "1\n");
	}
	git(work, "add", ".");
	git(
		work,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@example.com",
		"commit",
		"-q",
		"-m",
		"init",
	);
	git(work, "remote", "add", "origin", remote);
	git(work, "push", "-q", "origin", "main");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env bash\necho "$@" >> "${ghLog}"\n`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(join(work, "package.json"), "2\n");
	const run = () =>
		spawnSync("bash", [script], {
			cwd: work,
			encoding: "utf8",
			env: {
				...process.env,
				VERSION: "9.9.9",
				PATH: `${bin}:${process.env.PATH}`,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
	return { remote, work, ghLog, run };
}

describe("open-browser-stack-pr.sh", () => {
	it("skips without pushing when the branch already exists on origin", () => {
		const { remote, work, ghLog, run } = setup();
		git(work, "push", "-q", "origin", "main:chore/browser-stack-9.9.9");
		const result = run();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("already exists");
		expect(() => readFileSync(ghLog)).toThrow();
		expect(git(remote, "rev-parse", "chore/browser-stack-9.9.9")).toBe(
			git(remote, "rev-parse", "main"),
		);
	});

	it("pushes the branch and opens the pull request when it does not exist", () => {
		const { remote, ghLog, run } = setup();
		const result = run();
		expect(result.status).toBe(0);
		expect(
			git(remote, "branch", "--list", "chore/browser-stack-9.9.9"),
		).toContain("chore/browser-stack-9.9.9");
		expect(readFileSync(ghLog, "utf8")).toContain("pr create");
	});
});
