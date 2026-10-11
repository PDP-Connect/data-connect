// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_COMMIT = "3b05c1b1e4db56c9cb2820e5bae570d6d3a73024";
const EXPECTED_TYPESCRIPT = "7.0.2";
const EXPECTED_AJV = "8.20.0";
const EXPECTED_VERSION = "0.1.0-proto.1";
const ARCHIVE_NAME = "pdpp-reference-contract-0.1.0-proto.1.tgz";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RI_ROOT = resolve(SCRIPT_DIR, "..");

function parseArgs(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!(key?.startsWith("--") && value) || options[key.slice(2)]) {
			throw new Error(
				"Usage: repack-reference-contract.mjs --source <signed-checkout> --output <empty-disk-backed-dir>",
			);
		}
		options[key.slice(2)] = value;
	}
	assert.deepEqual(
		Object.keys(options).sort(),
		["output", "source"],
		"source and output are required",
	);
	return { output: resolve(options.output), source: resolve(options.source) };
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root) {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

function run(command, args, options = {}) {
	const output = execFileSync(command, args, { encoding: "utf8", ...options });
	return typeof output === "string" ? output.trim() : "";
}

function getPackResult(stdout) {
	const parsed = JSON.parse(stdout);
	const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	assert.ok(result?.filename, "npm pack did not report an archive filename");
	return result;
}

function verifySourcePin(source) {
	const head = run("git", ["rev-parse", "HEAD"], { cwd: source });
	assert.equal(
		head,
		EXPECTED_COMMIT,
		"source checkout is not the pinned reference-contract commit",
	);
	run("git", ["verify-commit", EXPECTED_COMMIT], {
		cwd: source,
		stdio: "ignore",
	});
	assert.equal(
		run("git", ["show", "-s", "--format=%G?", EXPECTED_COMMIT], {
			cwd: source,
		}),
		"G",
	);
	assert.equal(
		run(
			"git",
			[
				"status",
				"--porcelain=v1",
				"--untracked-files=all",
				"--",
				"packages/reference-contract",
				"pnpm-lock.yaml",
			],
			{ cwd: source },
		),
		"",
		"packaged source and compiler lock must match the signed commit",
	);

	const lock = readFileSync(join(source, "pnpm-lock.yaml"), "utf8");
	assert.match(
		lock,
		/^ {2}typescript@7\.0\.2:$/m,
		"source lock does not pin TypeScript 7.0.2",
	);
	assert.match(
		lock,
		/^ {2}ajv@8\.20\.0:$/m,
		"source lock does not pin AJV 8.20.0",
	);

	const typescriptPackage = readJson(
		join(source, "node_modules/typescript/package.json"),
	);
	const ajvPackage = readJson(
		join(source, "packages/reference-contract/node_modules/ajv/package.json"),
	);
	assert.equal(typescriptPackage.version, EXPECTED_TYPESCRIPT);
	assert.equal(ajvPackage.version, EXPECTED_AJV);
	return { ajvPackage, typescriptPackage };
}

function prepareBuildConfig(source, packageRoot) {
	const configPath = join(packageRoot, "tsconfig.json");
	const sourceConfig = JSON.parse(
		readFileSync(configPath, "utf8").replace(/\/\/[^\n]*/g, ""),
	);

	const config = {
		...sourceConfig,
		compilerOptions: {
			...sourceConfig.compilerOptions,
			declaration: true,
			noEmit: false,
			outDir: "./dist",
			rewriteRelativeImportExtensions: true,
			rootDir: "./src",
			typeRoots: [join(source, "node_modules/@types")],
		},
		include: ["src/**/*.ts", "src/**/*.js"],
	};
	const buildConfigPath = join(packageRoot, "tsconfig.build.json");
	writeFileSync(buildConfigPath, `${JSON.stringify(config, null, 2)}\n`);
	return buildConfigPath;
}

function compiledPath(sourcePath, extension) {
	return sourcePath.replace("./src/", "./dist/").replace(/\.ts$/, extension);
}

function rewritePackage(packageRoot) {
	const packagePath = join(packageRoot, "package.json");
	const pkg = readJson(packagePath);
	pkg.version = EXPECTED_VERSION;
	pkg.main = compiledPath(pkg.main, ".js");
	pkg.types = "./dist/index.d.ts";
	for (const [name, target] of Object.entries(pkg.exports)) {
		assert.equal(
			typeof target,
			"string",
			`unexpected source export shape for ${name}`,
		);
		pkg.exports[name] = Object.fromEntries([
			["types", compiledPath(target, ".d.ts")],
			["import", compiledPath(target, ".js")],
		]);
	}
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function buildAndPack(source, sourcePackage, output, pass) {
	const passRoot = join(output, `pass-${pass}`);
	const sourcePackDir = join(passRoot, "source-pack");
	const extractRoot = join(passRoot, "extract");
	const finalPackDir = join(passRoot, "final-pack");
	for (const directory of [sourcePackDir, extractRoot, finalPackDir]) {
		mkdirSync(directory, { recursive: true });
	}

	const sourcePack = getPackResult(
		run(
			"npm",
			[
				"pack",
				"--json",
				"--workspaces=false",
				"--pack-destination",
				sourcePackDir,
			],
			{
				cwd: sourcePackage,
			},
		),
	);
	const sourceTarball = join(sourcePackDir, sourcePack.filename);
	run("tar", ["-xzf", sourceTarball, "-C", extractRoot]);
	const packageRoot = join(extractRoot, "package");
	const packageNodeModules = join(packageRoot, "node_modules");
	const packageDependencies = join(sourcePackage, "node_modules");
	assert.ok(
		realpathSync(packageDependencies).startsWith(realpathSync(source)),
		"dependencies must resolve inside the explicit source checkout",
	);
	symlinkSync(packageDependencies, packageNodeModules, "dir");

	const buildConfigPath = prepareBuildConfig(source, packageRoot);
	const tsc = join(source, "node_modules/.bin/tsc");
	run(tsc, ["--pretty", "false", "-p", buildConfigPath], {
		cwd: packageRoot,
		stdio: "inherit",
	});
	rmSync(buildConfigPath);
	rmSync(packageNodeModules);
	rewritePackage(packageRoot);

	const sourceFiles = listFiles(join(packageRoot, "src"));
	const compiledFiles = listFiles(join(packageRoot, "dist"));
	assert.equal(
		sourceFiles.length,
		18,
		"source package should contain the pinned 18 source modules",
	);
	assert.equal(
		compiledFiles.length,
		36,
		"compiler should emit JS and declarations for all 18 modules",
	);

	const packed = getPackResult(
		run(
			"npm",
			[
				"pack",
				"--json",
				"--workspaces=false",
				"--pack-destination",
				finalPackDir,
			],
			{
				cwd: packageRoot,
			},
		),
	);
	const archive = join(finalPackDir, packed.filename);
	const manifest = listFiles(packageRoot).map((path) => ({
		path: path.slice(packageRoot.length + 1).replaceAll("\\", "/"),
		sha256: sha256File(path),
	}));
	return {
		archive: archive.slice(output.length + 1).replaceAll("\\", "/"),
		compiledFiles: compiledFiles.map((path) =>
			path.slice(packageRoot.length + 1).replaceAll("\\", "/"),
		),
		manifest,
		sha256: sha256File(archive),
		sourceFiles: sourceFiles.map((path) =>
			path.slice(packageRoot.length + 1).replaceAll("\\", "/"),
		),
	};
}

const { output, source } = parseArgs(process.argv.slice(2));
assert.ok(
	lstatSync(dirname(output)).isDirectory(),
	"output parent must already exist on disk",
);
if (lstatSync(output, { throwIfNoEntry: false })) {
	assert.equal(
		readdirSync(output).length,
		0,
		"output directory must be empty; existing files are never removed",
	);
} else {
	mkdirSync(output, { recursive: true });
}

const sourcePackage = join(source, "packages/reference-contract");
assert.ok(
	lstatSync(sourcePackage).isDirectory(),
	"source checkout does not contain packages/reference-contract",
);
const { ajvPackage, typescriptPackage } = verifySourcePin(source);
const sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: source });
const version = (command) => run(command, ["--version"]);

const first = buildAndPack(source, sourcePackage, output, 1);
const second = buildAndPack(source, sourcePackage, output, 2);
assert.equal(
	first.sha256,
	second.sha256,
	"independent source-pack/build/pack runs produced different archives",
);
assert.deepEqual(
	first.manifest,
	second.manifest,
	"independent builds produced different package content",
);

const checksumManifest = readFileSync(
	join(RI_ROOT, "vendor/SHA256SUMS"),
	"utf8",
);
const checksumRow = checksumManifest
	.split(/\r?\n/)
	.find((line) =>
		line.endsWith(` reference-implementation/vendor/${ARCHIVE_NAME}`),
	);
const activeArchiveSha256 = checksumRow?.match(/^([a-f0-9]{64})\s/)?.[1];
assert.ok(
	activeArchiveSha256,
	`active SHA256SUMS has no entry for ${ARCHIVE_NAME}`,
);
assert.equal(
	second.sha256,
	activeArchiveSha256,
	"repacked content differs from the active SHA256SUMS digest",
);

const receipt = {
	activeArchiveSha256,
	archive: second.archive,
	contentManifest: second.manifest,
	counts: {
		compiledFiles: second.compiledFiles.length,
		sourceFiles: second.sourceFiles.length,
	},
	firstSha256: first.sha256,
	repackCount: 2,
	secondSha256: second.sha256,
	sha256: second.sha256,
	signatureVerified: true,
	sourceCommit,
	versions: {
		ajv: ajvPackage.version,
		node: version(process.execPath),
		npm: version("npm"),
		typescript: typescriptPackage.version,
	},
};
writeFileSync(
	join(output, "receipt.json"),
	`${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
	JSON.stringify(
		{
			archive: receipt.archive,
			receipt: join(output, "receipt.json"),
			sha256: receipt.sha256,
		},
		null,
		2,
	),
);
