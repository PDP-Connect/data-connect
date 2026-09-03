// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { discoverTestFiles } from "./run-tests-discovery.ts";
import { contentDigest, gitHead, gitRoot, sourceTreeDigest } from "./test-accounting/inventory.ts";
import { repositoryPaths, structuredNodeSummary } from "./test-accounting/receipt.ts";

export const GATE_CONCURRENCY_RECEIPT_SCHEMA = "pdpp.gate-concurrency-receipt/v1";

export interface GateConcurrencyReceipt {
  cap: number;
  counts: ReturnType<typeof structuredNodeSummary> & { completed_files: number; planned_files: number };
  ended_at: string;
  exit_code: number;
  failure_identities: string[];
  git_head: string;
  node_version: string;
  profile: "memory-default";
  schema: typeof GATE_CONCURRENCY_RECEIPT_SCHEMA;
  selected_files: string[];
  selected_files_sha256: string;
  selection_manifest_sha256: string;
  source_tree_sha256: string;
  started_at: string;
  transcript: string;
  transcript_sha256: string;
}

interface TranscriptEvent {
  details?: { name?: string; skip?: boolean | string; type?: string };
  type: string;
}

function fail(message: string): never {
  throw new Error(`gate concurrency receipt: ${message}`);
}

function eventLines(output: string): TranscriptEvent[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("PDPP_TEST_ACCOUNTING_EVENT "))
    .map((line) => JSON.parse(line.slice("PDPP_TEST_ACCOUNTING_EVENT ".length)) as TranscriptEvent);
}

export function failureIdentities(output: string): string[] {
  return eventLines(output)
    .filter((event) => event.type === "test:fail" && event.details?.type === "test" && !event.details.skip)
    .map((event) => event.details?.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

export function buildGateConcurrencyReceipt({
  cap,
  endedAt,
  exitCode,
  gitHeadSha,
  output,
  selectedFiles,
  sourceTreeSha256,
  startedAt,
  transcript,
}: {
  cap: number;
  endedAt: string;
  exitCode: number;
  gitHeadSha: string;
  output: string;
  selectedFiles: string[];
  sourceTreeSha256: string;
  startedAt: string;
  transcript: string;
}): GateConcurrencyReceipt {
  if (!Number.isInteger(cap) || cap <= 0) {
    fail("cap must be a positive integer");
  }
  const summary = structuredNodeSummary(output);
  const counts = {
    ...summary,
    completed_files: exitCode === 0 ? selectedFiles.length : 0,
    planned_files: selectedFiles.length,
  };
  if (counts.assertions !== counts.passed + counts.failed + counts.skipped) {
    fail("structured output has inconsistent assertion counts");
  }
  return {
    cap,
    counts,
    ended_at: endedAt,
    exit_code: exitCode,
    failure_identities: failureIdentities(output),
    git_head: gitHeadSha,
    node_version: process.version,
    profile: "memory-default",
    schema: GATE_CONCURRENCY_RECEIPT_SCHEMA,
    selected_files: selectedFiles,
    selected_files_sha256: contentDigest(JSON.stringify(selectedFiles)),
    selection_manifest_sha256: contentDigest(
      JSON.stringify({ cap, node_version: process.version, profile: "memory-default", selected_files: selectedFiles })
    ),
    source_tree_sha256: sourceTreeSha256,
    started_at: startedAt,
    transcript: basename("gate-concurrency-memory.transcript"),
    transcript_sha256: contentDigest(transcript),
  };
}

export function assertGateConcurrencyReceipt(receipt: GateConcurrencyReceipt, transcript: string): void {
  if (receipt.schema !== GATE_CONCURRENCY_RECEIPT_SCHEMA || receipt.profile !== "memory-default") {
    fail("receipt schema or profile is invalid");
  }
  if (receipt.transcript_sha256 !== contentDigest(transcript)) {
    fail("transcript digest does not match");
  }
  if (receipt.selected_files_sha256 !== contentDigest(JSON.stringify(receipt.selected_files))) {
    fail("selected-file digest does not match");
  }
  const lines = transcript.split("\n").filter(Boolean);
  if (
    receipt.selection_manifest_sha256 !==
    contentDigest(
      JSON.stringify({
        cap: receipt.cap,
        node_version: receipt.node_version,
        profile: receipt.profile,
        selected_files: receipt.selected_files,
      })
    )
  ) {
    fail("selection manifest digest does not match");
  }
  const start = JSON.parse(lines[0] ?? "{}") as { cap?: number; event?: string; git_head?: string; profile?: string };
  const end = JSON.parse(lines.at(-1) ?? "{}") as { event?: string; exit_code?: number };
  if (
    start.event !== "start" ||
    start.cap !== receipt.cap ||
    start.git_head !== receipt.git_head ||
    start.profile !== receipt.profile
  ) {
    fail("transcript start does not bind receipt settings");
  }
  if (end.event !== "end" || end.exit_code !== receipt.exit_code) {
    fail("transcript end does not bind receipt exit code");
  }
}

function parseArgs(argv: string[]): { cap: number; outputDirectory: string } {
  const capIndex = argv.indexOf("--cap");
  const outputIndex = argv.indexOf("--output-directory");
  if (argv.length !== 4 || capIndex === -1 || outputIndex === -1) {
    fail("usage: gate-concurrency-receipt.ts --cap <positive integer> --output-directory <path>");
  }
  const cap = Number.parseInt(argv[capIndex + 1] ?? "", 10);
  const outputDirectory = argv[outputIndex + 1];
  if (!Number.isInteger(cap) || cap <= 0 || !outputDirectory) {
    fail("cap must be a positive integer and output-directory must be set");
  }
  return { cap, outputDirectory: resolve(outputDirectory) };
}

function assertCleanTree(root: string): void {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status) {
    fail("receipt generation requires a clean source tree");
  }
}

async function capture(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolveCapture, reject) => {
    const [file, ...args] = command;
    if (!file) {
      reject(new Error("receipt command is empty"));
      return;
    }
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolveCapture({ exitCode: code ?? 1, output }));
  });
}

async function main(): Promise<void> {
  const { cap, outputDirectory } = parseArgs(process.argv.slice(2));
  const root = gitRoot();
  assertCleanTree(root);
  const repoRoot = resolve(root, "reference-implementation");
  const head = gitHead(root);
  const testFiles = await discoverTestFiles(repoRoot, resolve(repoRoot, "test"));
  const selectedFiles = repositoryPaths("reference-implementation", testFiles);
  const startedAt = new Date().toISOString();
  const result = await capture([process.execPath, "scripts/run-tests.ts"], repoRoot, {
    ...process.env,
    PDPP_TEST_CONCURRENCY: String(cap),
    PDPP_TEST_PROFILE: "memory-default",
  });
  const endedAt = new Date().toISOString();
  assertCleanTree(root);
  const transcript = `${JSON.stringify({ cap, event: "start", git_head: head, profile: "memory-default", started_at: startedAt })}\n${JSON.stringify({ event: "output", output: result.output })}\n${JSON.stringify({ ended_at: endedAt, event: "end", exit_code: result.exitCode })}\n`;
  const receipt = buildGateConcurrencyReceipt({
    cap,
    endedAt,
    exitCode: result.exitCode,
    gitHeadSha: head,
    output: result.output,
    selectedFiles,
    sourceTreeSha256: sourceTreeDigest(root, head),
    startedAt,
    transcript,
  });
  const prefix = `gate-concurrency-memory-cap-${cap}`;
  receipt.transcript = `${prefix}.transcript`;
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, receipt.transcript), transcript, { flag: "wx" });
  await writeFile(resolve(outputDirectory, `${prefix}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  assertGateConcurrencyReceipt(receipt, transcript);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = result.exitCode;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
