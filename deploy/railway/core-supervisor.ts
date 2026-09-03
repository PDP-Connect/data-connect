#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";

const children = new Map<string, ChildProcess>();
let shuttingDown = false;
let exitCode = 0;

const DEFAULT_XVFB_DISPLAY = ":99";
const DEFAULT_XVFB_SCREEN = "1920x1080x24";
const XVFB_START_TIMEOUT_MS = 10_000;
const REFERENCE_READY_POLL_MS = 100;
const DEFAULT_REFERENCE_READY_FILE = "/tmp/pdpp-reference-ready";
const DISPLAY_RE = /^:\d+$/u;
const SCREEN_RE = /^\d+x\d+x(?:8|16|24|32)$/u;

function configuredDisplay(): string {
	const display = process.env.PDPP_XVFB_DISPLAY?.trim() || DEFAULT_XVFB_DISPLAY;
	if (!DISPLAY_RE.test(display)) {
		throw new Error(
			`PDPP_XVFB_DISPLAY must be an X display such as :99, got ${display}`,
		);
	}
	return display;
}

function configuredScreen(): string {
	const screen = process.env.PDPP_XVFB_SCREEN?.trim() || DEFAULT_XVFB_SCREEN;
	if (!SCREEN_RE.test(screen)) {
		throw new Error(
			`PDPP_XVFB_SCREEN must be WIDTHxHEIGHTxDEPTH, got ${screen}`,
		);
	}
	return screen;
}

function start(
	name: string,
	command: string,
	args: string[],
	options: SpawnOptions,
): ChildProcess {
	const child = spawn(command, args, { ...options, stdio: "inherit" });
	children.set(name, child);
	child.on("exit", (code, signal) => {
		children.delete(name);
		if (code !== 0 || signal) {
			exitCode = code ?? 1;
		}
		if (shuttingDown) {
			if (children.size === 0) {
				process.exit(exitCode);
			}
			return;
		}
		shuttingDown = true;
		for (const [otherName, other] of children.entries()) {
			console.error(`[core] ${name} exited; stopping ${otherName}`);
			other.kill("SIGTERM");
		}
		if (children.size === 0) {
			process.exit(exitCode);
		}
	});
	return child;
}

function stop(signal: NodeJS.Signals): void {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	for (const child of children.values()) {
		child.kill(signal);
	}
	if (children.size === 0) {
		process.exit(exitCode);
	}
}

async function startManagedDisplay(): Promise<string | undefined> {
	if (process.env.PDPP_BROWSER_HEADLESS === "1") {
		return;
	}
	const display = configuredDisplay();
	const xvfb = start(
		"xvfb",
		"Xvfb",
		[display, "-screen", "0", configuredScreen(), "-nolisten", "tcp", "-ac"],
		{
			cwd: "/app",
			env: process.env,
		},
	);
	const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
	const deadline = Date.now() + XVFB_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (xvfb.exitCode !== null || xvfb.signalCode !== null) {
			throw new Error(`Xvfb exited before ${display} became ready`);
		}
		if (existsSync(socket)) {
			console.log(`[core] managed Xvfb ready on ${display}`);
			return display;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(
		`Xvfb did not create ${socket} within ${String(XVFB_START_TIMEOUT_MS)}ms`,
	);
}

function referenceReadyFile(): string {
	return (
		process.env.PDPP_REFERENCE_READY_FILE?.trim() ||
		DEFAULT_REFERENCE_READY_FILE
	);
}

function clearReferenceReadyFile(file: string): void {
	try {
		unlinkSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

async function waitForTcpPort(
	child: ChildProcess,
	port: number,
): Promise<void> {
	for (;;) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(
				`reference server exited before port ${String(port)} became ready`,
			);
		}
		const listening = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection({
				host: "127.0.0.1",
				port,
				timeout: REFERENCE_READY_POLL_MS,
			});
			const finish = (value: boolean) => {
				socket.destroy();
				resolve(value);
			};
			socket.once("connect", () => finish(true));
			socket.once("error", () => finish(false));
			socket.once("timeout", () => finish(false));
		});
		if (listening) {
			return;
		}
		await new Promise((resolve) =>
			setTimeout(resolve, REFERENCE_READY_POLL_MS),
		);
	}
}

async function publishReferenceReadiness(
	child: ChildProcess,
	file: string,
): Promise<void> {
	await Promise.all([waitForTcpPort(child, 7662), waitForTcpPort(child, 7663)]);
	writeFileSync(file, "ready\n", { mode: 0o600 });
	console.log(
		"[core] reference services ready; dashboard requests can now be served",
	);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

async function main(): Promise<void> {
	const readyFile = referenceReadyFile();
	clearReferenceReadyFile(readyFile);
	const display = await startManagedDisplay();
	const childBaseEnv = { ...process.env, DISPLAY: display };
	const referenceEnv = {
		...childBaseEnv,
		AS_PORT: "7662",
		RS_PORT: "7663",
		PDPP_AS_URL: "http://127.0.0.1:7662",
		PDPP_RS_URL: "http://127.0.0.1:7663",
		PDPP_REFERENCE_READY_FILE: readyFile,
	};
	const consoleEnv = {
		...childBaseEnv,
		HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
		PORT: process.env.PORT || "3000",
		PDPP_AS_URL: "http://127.0.0.1:7662",
		PDPP_RS_URL: "http://127.0.0.1:7663",
		PDPP_REFERENCE_READY_FILE: readyFile,
	};

	const reference = start(
		"reference",
		process.execPath,
		["--import", "tsx", "/app/reference-implementation/server/index.ts"],
		{
			cwd: "/app",
			env: referenceEnv,
		},
	);
	start("console", process.execPath, ["/console/apps/console/server.js"], {
		cwd: "/console",
		env: consoleEnv,
	});
	publishReferenceReadiness(reference, readyFile).catch((error: unknown) => {
		if (shuttingDown) {
			return;
		}
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`[core] reference readiness failed: ${detail}`);
		stop("SIGTERM");
	});
}

main().catch((error: unknown) => {
	exitCode = 1;
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[core] startup failed: ${message}`);
	stop("SIGTERM");
});
