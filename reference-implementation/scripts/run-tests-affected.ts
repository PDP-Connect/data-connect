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
  /^package\.json$/,
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
  /** Import distance limit that produced `files`; "all" is the whole import closure (still heuristic). */
  depth?: number | "all";
  /** Count of closure tests at each shortest import distance (0 = changed test). */
  countsByDepth?: Record<number, number>;
}

export interface SelectionOptions {
  /** Maximum import distance from a changed file. Default 1; "all" takes the whole import closure, which is not a complete run. */
  depth?: number | "all";
}

const DEFAULT_DEPTH = 1;
// Basenames shared by many modules would match unrelated tests.
const GENERIC_BASENAMES = new Set(["index"]);

function basenameMatchedTests(
  repoRoot: string,
  changedModules: readonly string[],
  testAbs: readonly string[],
): Set<string> {
  const prefixes = changedModules
    .map((path) => (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""))
    .filter((name) => name && !GENERIC_BASENAMES.has(name));
  const matched = new Set<string>();
  for (const testPath of testAbs) {
    const rel = relative(repoRoot, testPath).replaceAll("\\", "/");
    if (!rel.startsWith("test/") || !rel.endsWith(".test.ts")) continue;
    const name = rel.split("/").at(-1) ?? rel;
    if (prefixes.some((prefix) => name.startsWith(prefix))) matched.add(testPath);
  }
  return matched;
}

function isModulePath(path: string): boolean {
  return MODULE_EXTENSIONS.includes(
    extname(path) as (typeof MODULE_EXTENSIONS)[number],
  );
}

const CODE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;

function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.includes(extname(path) as (typeof CODE_EXTENSIONS)[number]);
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
    // A literal require("./x") (CommonJS) is a static edge like an import.
    if (
      token.value === "require" &&
      tokens[index - 1]?.value !== "." &&
      tokens[index + 1]?.value === "(" &&
      isString(tokens[index + 2]) &&
      tokens[index + 3]?.value === ")"
    ) {
      const specifier = tokens[index + 2];
      if (isString(specifier) && specifier.value.startsWith("."))
        imports.push(specifier.value);
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
        tokens
          .slice(index + 5, index + 10)
          .map((token) => token?.value)
          .join("") === "import.meta.url"
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

/**
 * A recall heuristic for the edit loop, never a merge oracle: tests reachable
 * from the changed code modules through static import, literal require and
 * `new URL(..., import.meta.url)` edges, ranked by import distance. A static
 * graph cannot see variable imports or paths built at run time, so any
 * changed non-code file falls back to full discovery and the full RI gate
 * stays the backstop.
 */
export async function selectAffectedTests(
  repoRoot: string,
  discoveredTests: readonly string[],
  changes: ChangeSet,
  options: SelectionOptions = {},
): Promise<Selection> {
  const depthLimit = options.depth ?? DEFAULT_DEPTH;
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

  // Narrow only on module-graph evidence. A changed code module that the
  // graph reaches selects its importers; any other changed file (JSON, SQL,
  // fixtures, any asset) can be read by a path built at run time, which no
  // static scan proves complete, so it falls back to full discovery.
  const direct = new Set<string>();
  const unresolved: string[] = [];
  for (const [index, path] of changedRel.entries()) {
    const absolute = resolve(repoRoot, path);
    if (isCodePath(path) && sources.has(absolute)) {
      direct.add(absolute);
      continue;
    }
    unresolved.push(changed[index] ?? path);
  }
  if (unresolved.length > 0)
    return fallback(`changed file is not a code module in the import graph: ${unresolved[0]}`);

  // Multi-source BFS over the reverse import graph: distance 0 is a changed
  // module, 1 is a module that imports it, and so on.
  const importers = new Map<string, string[]>();
  for (const [modulePath, dependencies] of graph)
    for (const dependency of dependencies) {
      const list = importers.get(dependency);
      if (list) list.push(modulePath);
      else importers.set(dependency, [modulePath]);
    }
  const distance = new Map<string, number>([...direct].map((m) => [m, 0]));
  const frontier = [...direct];
  for (let head = 0; head < frontier.length; head += 1) {
    const modulePath = frontier[head] as string;
    const next = (distance.get(modulePath) ?? 0) + 1;
    for (const importer of importers.get(modulePath) ?? [])
      if (!distance.has(importer)) {
        distance.set(importer, next);
        frontier.push(importer);
      }
  }
  const countsByDepth: Record<number, number> = {};
  const closure = new Map<string, number>();
  for (const testPath of new Set(testAbs)) {
    const testDistance = distance.get(testPath);
    if (testDistance === undefined) continue;
    closure.set(testPath, testDistance);
    countsByDepth[testDistance] = (countsByDepth[testDistance] ?? 0) + 1;
  }
  const chosen = new Set<string>();
  for (const [testPath, testDistance] of closure)
    if (depthLimit === "all" || testDistance <= depthLimit) chosen.add(testPath);
  if (depthLimit !== "all")
    for (const testPath of basenameMatchedTests(
      repoRoot,
      changedRel.filter((path) => isModulePath(path)),
      testAbs,
    ))
      chosen.add(testPath);
  const selected = [...chosen].map((path) =>
    relative(repoRoot, path).replaceAll("\\", "/"),
  );
  const discovered = new Set(testAbs);
  // A new or edited test can change what the inventory tests read (file
  // names, registrations, markers), so either one selects them.
  const changedTests = changes.addedOrModified
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.startsWith("reference-implementation/test/"))
    .map((path) =>
      resolve(repoRoot, path.slice("reference-implementation/".length)),
    )
    .filter((path) => discovered.has(path));
  if (changedTests.length > 0) {
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
  const scope =
    depthLimit === "all"
      ? "import closure (heuristic)"
      : `affected tests within import depth ${depthLimit}`;
  const reason =
    selected.length > 0
      ? `${scope} for ${changed.join(", ")}${changedTests.length > 0 ? "; changed test selects test-tree inventory tests" : ""}`
      : `no discovered tests depend on ${changed.join(", ")}`;
  return {
    files: selected.sort(),
    reason,
    fallback: false,
    depth: depthLimit,
    countsByDepth,
  };
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

export function parseDepth(args: readonly string[]): number {
  if (args.includes("--all"))
    throw new Error("--all was removed: no selection is complete; run the full RI gate (npm test)");
  const depthIndex = args.indexOf("--depth");
  if (depthIndex === -1) return DEFAULT_DEPTH;
  const value = Number(args[depthIndex + 1]);
  if (!Number.isInteger(value) || value < 0)
    throw new Error("--depth requires a non-negative integer N");
  return value;
}

export function formatDepthSummary(selection: Selection): string[] {
  if (selection.fallback || selection.countsByDepth === undefined) return [];
  const counts = Object.entries(selection.countsByDepth)
    .map(([depth, count]) => [Number(depth), count] as const)
    .sort((a, b) => a[0] - b[0]);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  const lines = [
    `[test:fast] tests by import depth: ${counts.map(([depth, count]) => `d${depth}=${count}`).join(" ") || "none"} (closure ${total}); depth used: ${selection.depth}`,
  ];
  if (selection.depth !== "all" && selection.files.length < total)
    lines.push(
      `[test:fast] widen with --depth N (import closure: ${total} tests, still heuristic)`,
    );
  return lines;
}

function gitPaths(repoRoot: string, ...args: string[]): string[] {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** Changed paths from `base` to the working tree, as the selector's input. */
export function collectChangeSet(repoRoot: string, base: string): ChangeSet {
  const changedNames = gitPaths(
    repoRoot,
    "diff",
    "--no-renames",
    "--name-only",
    base,
  );
  const staged = gitPaths(
    repoRoot,
    "diff",
    "--cached",
    "--no-renames",
    "--name-only",
  );
  const unstaged = gitPaths(repoRoot, "diff", "--no-renames", "--name-only");
  const untracked = gitPaths(
    repoRoot,
    "ls-files",
    "--full-name",
    "--others",
    "--exclude-standard",
  );
  const allChanged = [
    ...new Set([...changedNames, ...staged, ...unstaged, ...untracked]),
  ];
  // Fallback paths (root lockfiles, root package.json) stay in the set so the
  // selector's fallback rules see them; other unrelated paths are dropped.
  const relevant = allChanged.filter(
    (path) =>
      path.startsWith("reference-implementation/") ||
      /^(packages|scripts\/test-scratch|scripts\/test-sandbox)\//.test(path) ||
      FALLBACK_PATHS.some((pattern) => pattern.test(path)),
  );
  const deleted = [
    ...gitPaths(
      repoRoot,
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=D",
      base,
    ),
    ...gitPaths(
      repoRoot,
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
      "--diff-filter=D",
    ),
    ...gitPaths(
      repoRoot,
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=D",
    ),
  ];
  const deletedLocal = [
    ...new Set(deleted.filter((path) => relevant.includes(path))),
  ];
  const added = [
    ...gitPaths(
      repoRoot,
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=A",
      base,
    ),
    ...gitPaths(
      repoRoot,
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
      "--diff-filter=A",
    ),
    ...untracked,
  ];
  return {
    added: [...new Set(added.filter((path) => relevant.includes(path)))],
    addedOrModified: relevant.filter((path) => !deletedLocal.includes(path)),
    deleted: deletedLocal,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseOverride = baseIndex === -1 ? undefined : args[baseIndex + 1];
  if (baseIndex !== -1 && !baseOverride) throw new Error("--base requires REF");
  const dryRun = args.includes("--dry-run");
  const depth = parseDepth(args);
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const testFiles = await discoverTestFiles(repoRoot, join(repoRoot, "test"));
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
  const selection = await selectAffectedTests(
    repoRoot,
    testFiles,
    collectChangeSet(repoRoot, base),
    { depth },
  );
  console.log(
    "[test:fast] heuristic selection: run the full RI gate (npm test) before opening a PR",
  );
  console.log(
    `[test:fast] ${selection.files.length} test files; ${selection.reason}${selection.fallback ? " (fallback to full discovery)" : ""}`,
  );
  if (selection.fallback)
    console.log(`[test:fast] fallback reason: ${selection.reason}`);
  for (const line of formatDepthSummary(selection)) console.log(line);
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
