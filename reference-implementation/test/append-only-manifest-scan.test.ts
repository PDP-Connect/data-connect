// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	inspectAppendOnlyManifest,
	scanAppendOnlyStreams,
} from "../scripts/scan-append-only-streams.ts";

test("manifest scan inventories append-only streams and flags candidates without claiming a violation", () => {
	const result = inspectAppendOnlyManifest(
		{
			connector_key: "example",
			streams: [
				{ name: "profile", semantics: "mutable_state" },
				{
					name: "events",
					primary_key: ["id"],
					schema: {
						properties: {
							account_id: {},
							country: {},
							fetched_at: {},
							id: {},
							likes_count: {},
							occurred_at: {},
						},
					},
					semantics: "append_only",
				},
			],
			version: "0.1.0",
		},
		"connectors/example/manifest.json",
	);
	assert.deepEqual(result, [
		{
			connector: "example",
			fields: [
				"account_id",
				"country",
				"fetched_at",
				"id",
				"likes_count",
				"occurred_at",
			],
			manifest: "connectors/example/manifest.json",
			primary_key: ["id"],
			run_time_field_candidates: ["fetched_at"],
			source_mutable_field_candidates: ["likes_count"],
			stream: "events",
			version: "0.1.0",
		},
	]);
});

test("manifest scan reads source and shipped layouts while excluding generated and dependency trees", async () => {
	const directory = await mkdtemp(join(tmpdir(), "append-only-scan-"));
	try {
		for (const name of [
			"connectors/example",
			"manifests",
			"node_modules",
			"dist",
		]) {
			await mkdir(join(directory, name), { recursive: true });
		}
		const manifest = {
			connector_key: "example",
			streams: [
				{ name: "events", primary_key: ["id"], semantics: "append_only" },
			],
		};
		await writeFile(
			join(directory, "connectors/example/manifest.json"),
			JSON.stringify(manifest),
		);
		await writeFile(
			join(directory, "manifests/shipped.json"),
			JSON.stringify(manifest),
		);
		await writeFile(
			join(directory, "node_modules/manifest.json"),
			"invalid JSON",
		);
		await writeFile(join(directory, "dist/manifest.json"), "invalid JSON");
		const result = await scanAppendOnlyStreams(directory);
		assert.equal(result.manifest_count, 2);
		assert.equal(result.stream_count, 2);
		assert.equal(result.append_only_stream_count, 2);
		assert.deepEqual(
			result.streams.map((stream) => stream.stream),
			["events", "events"],
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("shipped apple-photos append_only emits different metadata for the same content-derived key", async () => {
	const registryUrl = import.meta.resolve(
		"@pdpp/polyfill-connectors/manifests",
	);
	const { readPolyfillManifests } = await import(registryUrl);
	const manifest = readPolyfillManifests().find(
		(entry: { file: string }) => entry.file === "apple_photos.json",
	)?.manifest;
	assert.equal(
		manifest?.streams.find(
			(stream: { name: string }) => stream.name === "photos",
		)?.semantics,
		"append_only",
	);
	const { buildPhotoRecord } = await import(
		new URL("../connectors/apple_photos/parsers.js", registryUrl).href
	);
	const file = {
		mtimeIso: "2026-10-01T00:00:00.000Z",
		path: "photo.jpg",
		sizeBytes: 10,
	};
	const hydration = {
		blobRef: null,
		contentSha256: "a".repeat(64),
		hydrationError: null,
		hydrationStatus: "skipped_too_large",
		sizeBytes: 10,
	};
	const first = buildPhotoRecord(file, "photo-a.jpg", hydration);
	const renamed = buildPhotoRecord(file, "photo-b.jpg", hydration);
	assert.equal(first.id, renamed.id);
	assert.notDeepEqual(first, renamed);
});
