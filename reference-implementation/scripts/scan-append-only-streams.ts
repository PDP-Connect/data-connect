// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ManifestStream {
	name: string;
	primary_key?: string[];
	schema?: { properties?: Record<string, unknown> };
	semantics: string;
}

interface ConnectorManifest {
	connector_key?: string;
	streams?: ManifestStream[];
	version?: string;
}

const RUN_TIME_FIELD =
	/^(?:fetched|collected|captured|observed|synced|scraped|exported)_at$/;
const SOURCE_MUTABLE_FIELD =
	/(?:^|_)(?:counts?|status|score|likes|followers|title|body|content|updated_at|edited_at)(?:_|$)/;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);

/** Candidates require implementation evidence; a manifest cannot prove re-emission. */
export function inspectAppendOnlyManifest(
	manifest: ConnectorManifest,
	manifestPath: string,
) {
	return (manifest.streams ?? [])
		.filter((stream) => stream.semantics === "append_only")
		.map((stream) => {
			const fields = Object.keys(stream.schema?.properties ?? {});
			return {
				connector: manifest.connector_key ?? null,
				fields,
				manifest: manifestPath,
				primary_key: stream.primary_key ?? [],
				run_time_field_candidates: fields.filter((field) =>
					RUN_TIME_FIELD.test(field),
				),
				source_mutable_field_candidates: fields.filter((field) =>
					SOURCE_MUTABLE_FIELD.test(field),
				),
				stream: stream.name,
				version: manifest.version ?? null,
			};
		});
}

async function manifestPaths(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const paths: string[] = [];
	const namedManifestDirectory = ["manifests", "seed-manifests"].includes(
		basename(directory),
	);
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
			paths.push(...(await manifestPaths(path)));
		} else if (
			entry.isFile() &&
			(entry.name === "manifest.json" ||
				(namedManifestDirectory && entry.name.endsWith(".json")))
		) {
			paths.push(path);
		}
	}
	return paths;
}

export async function scanAppendOnlyStreams(directory: string) {
	const manifests = await manifestPaths(resolve(directory));
	const streams = [];
	let streamCount = 0;
	for (const path of manifests) {
		const manifest = JSON.parse(
			await readFile(path, "utf8"),
		) as ConnectorManifest;
		streamCount += manifest.streams?.length ?? 0;
		streams.push(...inspectAppendOnlyManifest(manifest, path));
	}
	return {
		append_only_stream_count: streams.length,
		limitation:
			"Static manifest candidates only. Verify re-emission in connector code or a two-run replay.",
		manifest_count: manifests.length,
		stream_count: streamCount,
		streams,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const directory = process.argv[2];
	if (!directory) {
		throw new Error(
			"usage: node scripts/scan-append-only-streams.ts <connector-directory>",
		);
	}
	console.log(JSON.stringify(await scanAppendOnlyStreams(directory), null, 2));
}
