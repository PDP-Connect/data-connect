// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./run-tests-discovery.ts";

const MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".json"] as const;
const FALLBACK_PATHS = [
	/^reference-implementation\/package\.json$/,
	/(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
	/^reference-implementation\/tsconfig[^/]*\.json$/,
	/^reference-implementation\/scripts\/run-tests[^/]*\.ts$/,
	/^reference-implementation\/scripts\/(?:hermetic|test-accounting)\//,
	/^reference-implementation\/scripts\/(?:test-unit-preload\.mjs|test-env\.ts|test-profile-env\.ts)$/,
	/^(?:packages|scripts\/test-scratch|scripts\/test-sandbox)\//,
];

export interface ChangeSet {
	added?: string[];
	addedOrModified: string[];
	deleted: string[];
}

export interface Selection {
	files: string[];
	reason: string;
	fallback: boolean;
}

function isModulePath(path: string): boolean {
	return MODULE_EXTENSIONS.includes(
		extname(path) as (typeof MODULE_EXTENSIONS)[number],
	);
}

function enumeratesTestTree(source: string): boolean {
	if (/\bdiscoverTestFiles\s*\(/.test(source)) return true;
	// Inventory tests bind the test directory to __dirname before enumerating it.
	return (
		/\b(?:readdir(?:Sync)?|glob(?:Sync)?)\s*\(/.test(source) &&
		/\b(?:const|let|var)\s+(?:testDir|testsDir)\s*=\s*__dirname\b/.test(source)
	);
}

interface CodeToken {
	kind: "identifier" | "string" | "punctuation";
	value: string;
}

function tokenize(source: string): CodeToken[] {
	const tokens: CodeToken[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (
			char === " " ||
			char === "\n" ||
			char === "\r" ||
			char === "\t" ||
			char === "\f"
		) {
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			index = source.indexOf("\n", index + 2);
			if (index === -1) break;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (char === "'" || char === '"') {
			const quote = char;
			let value = "";
			index += 1;
			while (index < source.length && source[index] !== quote) {
				if (source[index] === "\\" && index + 1 < source.length) {
					value += source[index + 1];
					index += 2;
				} else {
					value += source[index];
					index += 1;
				}
			}
			index += 1;
			tokens.push({ kind: "string", value });
			continue;
		}
		if (char === "`") {
			index += 1;
			while (index < source.length) {
				if (source[index] === "\\") index += 2;
				else if (source[index] === "`") {
					index += 1;
					break;
				} else index += 1;
			}
			continue;
		}
		const code = char.charCodeAt(0);
		if (
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			char === "_" ||
			char === "$"
		) {
			const start = index++;
			while (index < source.length) {
				const part = source.charCodeAt(index);
				if (
					(part >= 65 && part <= 90) ||
					(part >= 97 && part <= 122) ||
					(part >= 48 && part <= 57) ||
					source[index] === "_" ||
					source[index] === "$"
				)
					index += 1;
				else break;
			}
			tokens.push({ kind: "identifier", value: source.slice(start, index) });
			continue;
		}
		tokens.push({ kind: "punctuation", value: char });
		index += 1;
	}
	return tokens;
}

function moduleReferences(source: string): {
	imports: string[];
	urls: string[];
} {
	const imports: string[] = [];
	const urls: string[] = [];
	const tokens = tokenize(source);
	const isString = (token: CodeToken | undefined): token is CodeToken =>
		token?.kind === "string";
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token?.kind !== "identifier") continue;
		if (
			(token.value === "import" || token.value === "export") &&
			tokens[index - 1]?.value !== "."
		) {
			if (token.value === "import" && tokens[index + 1]?.value === "(") {
				const specifier = tokens[index + 2];
				if (isString(specifier) && specifier.value.startsWith("."))
					imports.push(specifier.value);
				continue;
			}
			if (token.value === "import" && isString(tokens[index + 1])) {
				const specifier = tokens[index + 1];
				if (isString(specifier) && specifier.value.startsWith("."))
					imports.push(specifier.value);
				continue;
			}
			for (
				let cursor = index + 1;
				cursor < tokens.length && tokens[cursor]?.value !== ";";
				cursor += 1
			) {
				if (tokens[cursor]?.value === "from" && isString(tokens[cursor + 1])) {
					const specifier = tokens[cursor + 1];
					if (isString(specifier) && specifier.value.startsWith("."))
						imports.push(specifier.value);
					break;
				}
			}
			continue;
		}
		if (
			token.value === "new" &&
			tokens[index + 1]?.value === "URL" &&
			tokens[index + 2]?.value === "("
		) {
			const specifier = tokens[index + 3];
			if (
				isString(specifier) &&
				specifier.value.startsWith(".") &&
				tokens[index + 4]?.value === "," &&
				tokens[index + 5]?.value === "import" &&
				tokens[index + 6]?.value === "." &&
				tokens[index + 7]?.value === "meta" &&
				tokens[index + 8]?.value === "." &&
				tokens[index + 9]?.value === "url"
			)
				urls.push(specifier.value);
		}
	}
	return { imports, urls };
}

function candidatePaths(target: string): string[] {
	const extension = extname(target);
	const candidates = [target];
	if (extension) {
		if (extension === ".js") candidates.push(`${target.slice(0, -3)}.ts`);
		if (extension === ".mjs") candidates.push(`${target.slice(0, -4)}.mts`);
		if (extension === ".cjs") candidates.push(`${target.slice(0, -4)}.cts`);
		return candidates;
	}
	for (const suffix of MODULE_EXTENSIONS) candidates.push(target + suffix);
	for (const suffix of MODULE_EXTENSIONS)
		candidates.push(join(target, `index${suffix}`));
	return [...new Set(candidates)];
}

async function resolveLocalModule(
	basePath: string,
	specifier: string,
	cache: Map<string, Promise<string | undefined>>,
): Promise<string | undefined> {
	const key = `${dirname(basePath)}\0${specifier}`;
	const cached = cache.get(key);
	if (cached) return await cached;
	const resolution = resolveLocalModuleUncached(basePath, specifier);
	cache.set(key, resolution);
	return await resolution;
}

async function resolveLocalModuleUncached(
	basePath: string,
	specifier: string,
): Promise<string | undefined> {
	const target = resolve(dirname(basePath), specifier);
	for (const candidate of candidatePaths(target)) {
		try {
			if (!(await stat(candidate)).isFile()) continue;
			return candidate;
		} catch {
			// Try the next supported extension or index file.
		}
	}
	return undefined;
}

export async function validateFilesFrom(
	files: readonly string[],
	discovery: readonly string[],
): Promise<string[]> {
	const allowed = new Set(discovery);
	for (const file of files) {
		if (!allowed.has(file))
			throw new Error(`--files-from path is outside test discovery: ${file}`);
	}
	return [...new Set(files)].sort();
}

export async function selectAffectedTests(
	repoRoot: string,
	discoveredTests: readonly string[],
	changes: ChangeSet,
): Promise<Selection> {
	const changed = [...changes.addedOrModified, ...changes.deleted].map((path) =>
		path.replaceAll("\\", "/"),
	);
	if (changed.length === 0)
		return { files: [], reason: "no changed files", fallback: false };
	const fallback = (reason: string): Selection => ({
		files: [...discoveredTests].sort(),
		reason,
		fallback: true,
	});
	for (const path of changed) {
		if (FALLBACK_PATHS.some((pattern) => pattern.test(path)))
			return fallback(`unmodelled change: ${path}`);
	}
	const outside = changed.filter(
		(path) => !path.startsWith("reference-implementation/"),
	);
	if (outside.length > 0)
		return fallback(
			`change outside reference-implementation may affect RI resolution: ${outside[0]}`,
		);
	const deletedModule = changes.deleted.find((path) => isModulePath(path));
	if (deletedModule) return fallback(`deleted module: ${deletedModule}`);

	const changedRel = changed.map((path) =>
		path.slice("reference-implementation/".length),
	);
	const testAbs = discoveredTests.map((path) => resolve(repoRoot, path));
	const sources = new Map<string, string>();
	const graph = new Map<string, Set<string>>();
	const resolutionCache = new Map<string, Promise<string | undefined>>();
	const queue = [...new Set(testAbs)];
	while (queue.length > 0) {
		const batch = [...new Set(queue.splice(0, 256))].filter(
			(path) => !sources.has(path),
		);
		const results = await Promise.all(
			batch.map(async (modulePath) => {
				let source: string;
				try {
					source = await readFile(modulePath, "utf8");
				} catch {
					return {
						error: `could not read discovered module: ${relative(repoRoot, modulePath)}`,
					};
				}
				const dependencies = new Set<string>();
				if (extname(modulePath) !== ".json") {
					let references: ReturnType<typeof moduleReferences>;
					try {
						references = moduleReferences(source);
					} catch {
						return {
							error: `could not parse module: ${relative(repoRoot, modulePath)}`,
						};
					}
					const resolvedImports = await Promise.all(
						references.imports.map((specifier) =>
							resolveLocalModule(modulePath, specifier, resolutionCache),
						),
					);
					const unresolvedIndex = resolvedImports.findIndex(
						(resolved) => !resolved,
					);
					if (unresolvedIndex !== -1) {
						return {
							error: `unresolved local import ${references.imports[unresolvedIndex]} from ${relative(repoRoot, modulePath)}`,
						};
					}
					for (const imported of resolvedImports)
						if (imported) dependencies.add(imported);
					const resolvedUrls = await Promise.all(
						references.urls.map((specifier) =>
							resolveLocalModule(modulePath, specifier, resolutionCache),
						),
					);
					for (const resource of resolvedUrls)
						if (resource) dependencies.add(resource);
				}
				return { modulePath, source, dependencies };
			}),
		);
		for (const result of results) {
			if ("error" in result) return fallback(result.error);
			sources.set(result.modulePath, result.source);
			graph.set(result.modulePath, result.dependencies);
			queue.push(...result.dependencies);
		}
	}

	const direct = new Set<string>();
	const unresolved: string[] = [];
	for (const [index, path] of changedRel.entries()) {
		const absolute = resolve(repoRoot, path);
		if (sources.has(absolute)) {
			direct.add(absolute);
			continue;
		}
		if (isModulePath(path) && extname(path) !== ".json") {
			unresolved.push(path);
			continue;
		}
		const basename = path.split("/").at(-1) ?? path;
		const reference = [...sources].find(([modulePath, source]) => {
			const relativeAsset = relative(dirname(modulePath), absolute).replaceAll(
				"\\",
				"/",
			);
			return (
				source.includes(JSON.stringify(relativeAsset)) ||
				source.includes(JSON.stringify(basename))
			);
		});
		if (reference) direct.add(reference[0]);
		else unresolved.push(changed[index] ?? path);
	}
	if (unresolved.length > 0)
		return fallback(`unmodelled or unreferenced change: ${unresolved[0]}`);

	const selected: string[] = [];
	for (const testPath of testAbs) {
		const seen = new Set<string>();
		const visit = (modulePath: string): boolean => {
			if (direct.has(modulePath)) return true;
			if (seen.has(modulePath)) return false;
			seen.add(modulePath);
			for (const dependency of graph.get(modulePath) ?? [])
				if (visit(dependency)) return true;
			return false;
		};
		if (visit(testPath))
			selected.push(relative(repoRoot, testPath).replaceAll("\\", "/"));
	}
	const discovered = new Set(testAbs);
	const addedTests = (changes.added ?? [])
		.map((path) => path.replaceAll("\\", "/"))
		.filter((path) => path.startsWith("reference-implementation/test/"))
		.map((path) =>
			resolve(repoRoot, path.slice("reference-implementation/".length)),
		)
		.filter((path) => discovered.has(path));
	if (addedTests.length > 0) {
		for (const testPath of testAbs) {
			if (
				!selected.includes(
					relative(repoRoot, testPath).replaceAll("\\", "/"),
				) &&
				enumeratesTestTree(sources.get(testPath) ?? "")
			) {
				selected.push(relative(repoRoot, testPath).replaceAll("\\", "/"));
			}
		}
	}
	const reason =
		selected.length > 0
			? `affected import closure for ${changed.join(", ")}${addedTests.length > 0 ? "; added test selects test-tree inventory tests" : ""}`
			: `no discovered tests depend on ${changed.join(", ")}`;
	return { files: selected.sort(), reason, fallback: false };
}

function run(command: string, args: string[], cwd: string): Promise<number> {
	return new Promise((resolveCode, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", reject);
		child.on("close", (code, signal) => resolveCode(code ?? (signal ? 1 : 0)));
	});
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const baseIndex = args.indexOf("--base");
	const baseOverride = baseIndex === -1 ? undefined : args[baseIndex + 1];
	if (baseIndex !== -1 && !baseOverride) throw new Error("--base requires REF");
	const dryRun = args.includes("--dry-run");
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const testFiles = await discoverTestFiles(repoRoot, join(repoRoot, "test"));
	const gitPaths = (...args: string[]): string[] =>
		execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean);
	let base = baseOverride;
	if (!base) {
		try {
			base = execFileSync(
				"git",
				["merge-base", "HEAD", "origin/testeng/integration"],
				{ cwd: repoRoot, encoding: "utf8" },
			).trim();
		} catch {
			base = "origin/main";
		}
	}
	const changedNames = gitPaths("diff", "--name-only", base);
	const staged = gitPaths("diff", "--cached", "--name-only");
	const unstaged = gitPaths("diff", "--name-only");
	const untracked = gitPaths(
		"ls-files",
		"--full-name",
		"--others",
		"--exclude-standard",
	);
	const allChanged = [
		...new Set([...changedNames, ...staged, ...unstaged, ...untracked]),
	];
	const relevant = allChanged.filter(
		(path) =>
			path.startsWith("reference-implementation/") ||
			/^(packages|scripts\/test-scratch|scripts\/test-sandbox)\//.test(path),
	);
	const deleted = [
		...gitPaths("diff", "--name-only", "--diff-filter=D", base),
		...gitPaths("diff", "--cached", "--name-only", "--diff-filter=D"),
		...gitPaths("diff", "--name-only", "--diff-filter=D"),
	];
	const deletedLocal = [
		...new Set(deleted.filter((path) => relevant.includes(path))),
	];
	const added = [
		...gitPaths("diff", "--name-only", "--diff-filter=A", base),
		...gitPaths("diff", "--cached", "--name-only", "--diff-filter=A"),
		...untracked,
	];
	const selection = await selectAffectedTests(repoRoot, testFiles, {
		added: [...new Set(added.filter((path) => relevant.includes(path)))],
		addedOrModified: relevant.filter((path) => !deletedLocal.includes(path)),
		deleted: deletedLocal,
	});
	console.log(
		`[test:fast] ${selection.files.length} test files; ${selection.reason}${selection.fallback ? " (fallback to full discovery)" : ""}`,
	);
	for (const path of selection.files.slice(0, 20)) console.log(`  ${path}`);
	if (selection.files.length > 20)
		console.log(`  ... ${selection.files.length - 20} more`);
	if (dryRun) return;
	const scratchRoot = join(homedir(), ".tmp", "testeng", "dcri");
	await mkdir(scratchRoot, { recursive: true });
	const scratch = await mkdtemp(join(scratchRoot, "fast-selection-"));
	const listPath = join(scratch, "files.txt");
	await writeFile(listPath, selection.files.join("\n"));
	try {
		const exitCode = await run(
			process.execPath,
			["scripts/run-tests.ts", "--files-from", listPath],
			repoRoot,
		);
		process.exitCode = exitCode;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await main();
