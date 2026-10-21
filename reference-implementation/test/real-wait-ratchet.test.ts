// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Ratchet on real waits in RI test code (ledger DCR-18). Real sleeps and timers
// make tests slow and flaky under CPU contention, and there is no suite-wide
// fake clock. The policy is to fix a load-sensitive test at its cause: inject a
// clock, wait on an event, or poll with a deadline. This test keeps the number
// of real waits from growing, and asks for the baseline to move down when it
// shrinks.
//
// What counts as one real wait, found by a lexical scan of test code (comments
// and string contents are blanked first, so fixture source held in strings is
// not counted):
// - setTimeout(callback, N) or setInterval(callback, N) with N > 50;
// - setTimeout(N) with one argument (the node:timers/promises form), and
//   sleep(N), delay(N) or wait(N), with N > 50;
// where N is a numeric literal or a product of numeric literals (5 * 1000,
// 2_000, 1e3). Code inside a template literal's ${...} is scanned. Known
// limits of a lexical scan: a delay held in a variable or constant is not
// counted; a regular expression literal containing a quote or a parenthesis,
// and a TypeScript generic argument list containing a comma (fn<A, B>()), can
// shift the argument split. These under-count; they never count a short wait.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** The total at the time this ratchet was added. Lower it when real waits are removed. */
const BASELINE = 173;
/** How far the total may fall below BASELINE before the test asks to lower it. */
const SLACK = 5;
const THRESHOLD_MS = 50;

const TEST_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const SKIPPED_DIRECTORIES = new Set(["fixtures", "node_modules"]);
const TEST_FILE = /\.(?:ts|mjs|js)$/;

/**
 * Replace comments and string contents with spaces, keeping offsets. The code
 * inside a template literal's `${...}` is kept, so a wait written there counts.
 */
export function codeOnly(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") {
        out[i] = " ";
      }
    }
  };
  // Scans code from `index`; inside a template expression it stops at the
  // closing brace that matches the opening `${`, and returns its index.
  const scanCode = (start: number, inTemplateExpression: boolean): number => {
    let index = start;
    let braces = 0;
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];
      if (char === "/" && next === "/") {
        const end = source.indexOf("\n", index);
        const stop = end === -1 ? source.length : end;
        blank(index, stop);
        index = stop;
      } else if (char === "/" && next === "*") {
        const end = source.indexOf("*/", index + 2);
        const stop = end === -1 ? source.length : end + 2;
        blank(index, stop);
        index = stop;
      } else if (char === '"' || char === "'") {
        let cursor = index + 1;
        while (cursor < source.length && source[cursor] !== char && source[cursor] !== "\n") {
          cursor += source[cursor] === "\\" ? 2 : 1;
        }
        blank(index + 1, cursor);
        index = cursor + 1;
      } else if (char === "`") {
        index = scanTemplate(index + 1);
      } else if (inTemplateExpression && char === "{") {
        braces += 1;
        index += 1;
      } else if (inTemplateExpression && char === "}") {
        if (braces === 0) {
          return index;
        }
        braces -= 1;
        index += 1;
      } else {
        index += 1;
      }
    }
    return index;
  };
  // Blanks template text from `start` and keeps each `${...}` as code; returns
  // the index after the closing backtick.
  const scanTemplate = (start: number): number => {
    let index = start;
    let textStart = start;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
      } else if (char === "`") {
        blank(textStart, index);
        return index + 1;
      } else if (char === "$" && source[index + 1] === "{") {
        blank(textStart, index);
        index = scanCode(index + 2, true) + 1;
        textStart = index;
      } else {
        index += 1;
      }
    }
    blank(textStart, index);
    return index;
  };
  scanCode(0, false);
  return out.join("");
}

/** The top-level arguments of the call whose "(" is at `open`, or undefined if unbalanced. */
function callArguments(code: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(code.slice(start, index));
        return args.map((arg) => arg.trim()).filter((arg, i, all) => arg !== "" || i < all.length - 1);
      }
    } else if (char === "," && depth === 1) {
      args.push(code.slice(start, index));
      start = index + 1;
    }
  }
  return undefined;
}

/** The value of a numeric literal or a product of numeric literals, else undefined. */
const NUMBER = String.raw`\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?`;
const LITERAL_PRODUCT = new RegExp(`^${NUMBER}(?:\\s*\\*\\s*${NUMBER})*$`);

function literalMs(expression: string | undefined): number | undefined {
  if (expression === undefined || !LITERAL_PRODUCT.test(expression)) {
    return undefined;
  }
  return expression
    .split("*")
    .map((factor) => Number(factor.trim().replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
}

const CALL = /\b(setTimeout|setInterval|sleep|delay|wait)\s*\(/g;

/** The number of real waits longer than THRESHOLD_MS in `source`. */
export function countRealWaits(source: string): number {
  const code = codeOnly(source);
  let count = 0;
  for (const match of code.matchAll(CALL)) {
    const name = match[1];
    const before = code.slice(0, match.index).trimEnd().at(-1);
    if (before === "." && name !== "setTimeout" && name !== "setInterval") {
      continue; // e.g. page.wait(...) or object.delay(...)
    }
    const args = callArguments(code, match.index + match[0].length - 1);
    if (args === undefined || args.length === 0) {
      continue;
    }
    const isTimer = name === "setTimeout" || name === "setInterval";
    const delay = isTimer && args.length >= 2 ? args[1] : args.length === 1 ? args[0] : undefined;
    const ms = literalMs(delay);
    if (ms !== undefined && ms > THRESHOLD_MS) {
      count += 1;
    }
  }
  return count;
}

function testFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...testFiles(join(directory, entry.name)));
      }
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

test("the real-wait counter counts long literal waits and ignores short, computed and commented ones", () => {
  assert.equal(countRealWaits("setTimeout(fn, 2000);"), 1);
  assert.equal(countRealWaits("await delay(100);"), 1);
  assert.equal(countRealWaits("setTimeout(() => { done(); }, 5 * 1000);"), 1);
  assert.equal(countRealWaits("await setTimeout(1_500);"), 1);
  assert.equal(countRealWaits("setInterval(tick, 250);"), 1);
  assert.equal(countRealWaits("setTimeout(fn, 10);"), 0);
  assert.equal(countRealWaits("setTimeout(fn, ms);"), 0);
  assert.equal(countRealWaits("// setTimeout(fn, 5000)\n/* sleep(9000) */"), 0);
  assert.equal(countRealWaits('const fixture = "setTimeout(fn, 5000)";'), 0);
  assert.equal(countRealWaits("page.wait(5000);"), 0);
  assert.equal(countRealWaits("page. /* c */ wait(5000);"), 0);
  assert.equal(countRealWaits("const r = `${await sleep(100)}`;"), 1);
  assert.equal(countRealWaits("const r = `a ${`b ${await delay(200)}`} c`;"), 1);
  assert.equal(countRealWaits("const r = `setTimeout(fn, 5000)`;"), 0);
  assert.equal(countRealWaits("setTimeout(fn, 1e3); await sleep(100.5);"), 2);
});

test(`real waits over ${THRESHOLD_MS} ms in RI test code do not grow`, () => {
  const counts = testFiles(TEST_DIRECTORY)
    .map((path) => ({ count: countRealWaits(readFileSync(path, "utf8")), path: relative(TEST_DIRECTORY, path) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const top = counts
    .slice(0, 10)
    .map((entry) => `  ${entry.count}  ${entry.path}`)
    .join("\n");
  assert.ok(
    total <= BASELINE,
    `real waits over ${THRESHOLD_MS} ms rose to ${total} (baseline ${BASELINE}). Fix load-sensitive tests at the cause (inject a clock, wait on an event, or poll with a deadline); do not add real waits.\nMost real waits:\n${top}`
  );
  assert.ok(
    total >= BASELINE - SLACK,
    `real waits fell to ${total}; lower BASELINE in test/real-wait-ratchet.test.ts from ${BASELINE} to ${total} so the ratchet stays tight.`
  );
});
