import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/rust-unit-tests.yml");
const rustRoot = path.join(repoRoot, "src-tauri/src");

function pathFilterPatterns(workflow) {
  const paths = workflow.match(/^    paths:\n((?:      - .*\n)+)/m)?.[1];
  assert.ok(paths, "Rust workflow must define pull_request paths");

  return [...paths.matchAll(/^      - ["']?([^"'\n]+)["']?$/gm)].map(
    ([, pattern]) => pattern,
  );
}

function globMatches(pattern, filePath) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

function rustRepositoryInputs() {
  const sourceFiles = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith(".rs")) sourceFiles.push(entryPath);
    }
  }

  visit(rustRoot);

  return sourceFiles.flatMap((sourcePath) => {
    const source = readFileSync(sourcePath, "utf8");
    const compileTimeInputs = [...source.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)].map(
      ([, includePath]) =>
        path.relative(repoRoot, path.resolve(path.dirname(sourcePath), includePath)),
    );

    const testModuleStart = source.indexOf("#[cfg(test)]");
    if (testModuleStart === -1) return compileTimeInputs;

    const testSource = source.slice(testModuleStart);
    const manifestRoots = [...testSource.matchAll(
      /PathBuf::from\(env!\("CARGO_MANIFEST_DIR"\)\)([^;]*);/g,
    )].flatMap(([, chain]) => {
      let candidate = path.join(repoRoot, "src-tauri");
      for (const [, joinedPath] of chain.matchAll(/\.parent\(\)|\.join\("([^"]+)"\)/g)) {
        candidate = joinedPath === undefined
          ? path.dirname(candidate)
          : path.resolve(candidate, joinedPath);
      }
      if (!existsSync(candidate)) return [];
      const repoPath = path.relative(repoRoot, candidate);
      return [statSync(candidate).isDirectory() ? `${repoPath}/__rust_test_input__` : repoPath];
    });

    return [...compileTimeInputs, ...manifestRoots];
  });
}

function assertRustInputsAreFiltered(patterns, inputs) {
  const uncovered = inputs.filter(
    (input) => !patterns.some((pattern) => globMatches(pattern, input)),
  );
  assert.deepEqual(uncovered, [], "Rust test repository inputs missing from workflow paths");
}

test("Rust test source inputs are covered by the workflow path filter", () => {
  const patterns = pathFilterPatterns(readFileSync(workflowPath, "utf8"));
  assertRustInputsAreFiltered(patterns, rustRepositoryInputs());
});

test("the coverage check rejects a Rust input outside the workflow paths", () => {
  assert.throws(
    () => assertRustInputsAreFiltered(["src-tauri/**"], ["reference-implementation/server/new-contract.ts"]),
    /Rust test repository inputs missing from workflow paths/,
  );
});
