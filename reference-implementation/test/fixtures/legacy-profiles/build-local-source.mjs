// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Build a developer-local-source layout (profile/collection-profile.json,
// dist/collection-profile.mjs, provenance.json) from a data-connectors checkout.
// Reuses the esbuild settings of scripts/build-connector-oci-artifact.mjs
// (bundle, esm, node24, minifyWhitespace, same banner shape) and bypasses ONLY its
// slack/signal refusal (assertNoUnbundledNativeDependency) and the underscore key rule.
// No push, no signing.
//
// Reproduces the checked-in *.collection-profile.mjs.gz bundles (gzip -9 -n of dist/collection-profile.mjs).
// Needs a data-connectors checkout at the pinned revision with `npm ci --ignore-scripts` done (esbuild 0.28.2).
//   0.7.1  (data-connectors 861be44d48, origin/main, descends from 2afb7109):
//     node build-local-source.mjs --dcs <checkout@861be44d48> --connector slack --out <out>/slack
//     -> bundle sha256 d1be528ba5a175e1a0cfb9b4d9afe9b89e18fa891364536ef5e1698edc86a968
//   0.6.0  (data-connectors 97536ad49; older layout, so the connector dir, manifest and contract are explicit):
//     node build-local-source.mjs --dcs <checkout@97536ad49> --connector slack \
//       --connector-dir <checkout>/packages/polyfill-connectors/connectors/slack \
//       --manifest <checkout>/packages/polyfill-connectors/manifests/slack.json \
//       --contract <checkout@861be44d48>/scripts/connector-host-runtime-contract.mjs --out <out>/slack
//     -> bundle sha256 75022d8fd3b0ace2ef4bb7a4698bfbc876d17b5328ed713916f64ed5cabe34c2
//
// usage: node build-local-source.mjs --dcs <checkout> --connector <dir name> --out <dir>
//          [--manifest <path>] [--esbuild <path to esbuild main.js>] [--external a,b]
//          [--connector-dir <dir>] [--contract <host-runtime-contract.mjs>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const arg = (n, d = null) => {
	const i = process.argv.indexOf(n);
	if (i === -1) {
		if (d === null) throw new Error(`${n} required`);
		return d;
	}
	return process.argv[i + 1];
};
const dcs = arg("--dcs");
const name = arg("--connector");
const out = arg("--out");
const connectorDir = arg("--connector-dir", join(dcs, "connectors", name));
const manifestPath = arg("--manifest", join(connectorDir, "manifest.json"));
const entry = join(connectorDir, "index.ts");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const esbuild = await import(
	arg("--esbuild", join(dcs, "node_modules/esbuild/lib/main.js")).replace(
		/^(?!file:)/,
		"file://",
	)
);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "profile"), { recursive: true });
mkdirSync(join(out, "dist"), { recursive: true });

const profileBytes = readFileSync(manifestPath);
const profile = JSON.parse(profileBytes);
writeFileSync(join(out, "profile", "collection-profile.json"), profileBytes);

// Same externals as the OCI builder: the host-runtime contract's HOST_PROVIDED packages.
let hostProvided = [];
const contract = arg(
	"--contract",
	join(dcs, "scripts/connector-host-runtime-contract.mjs"),
);
if (existsSync(contract)) {
	hostProvided = [...(await import(`file://${contract}`)).HOST_PROVIDED.keys()];
}
const extra = arg("--external", "").split(",").filter(Boolean);
const outfile = join(out, "dist", "collection-profile.mjs");
const build = await esbuild.build({
	absWorkingDir: dcs,
	banner: {
		js: `/* GENERATED FILE (local-source layout, scratch build). */\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`,
	},
	bundle: true,
	entryPoints: [entry],
	external: [...hostProvided, ...extra],
	format: "esm",
	metafile: true,
	minifyWhitespace: true,
	outfile,
	platform: "node",
	sourcemap: false,
	target: "node24",
});
const externals = [
	...new Set(
		Object.values(build.metafile.inputs)
			.flatMap((i) => i.imports ?? [])
			.filter((e) => e.external)
			.map((e) => `${e.kind}:${e.path}`),
	),
].sort();

const revision = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: dcs,
	encoding: "utf8",
}).trim();
const bundleSha = sha(readFileSync(outfile));
const provenance = {
	builder:
		"scratch build-local-source.mjs (esbuild settings copied from scripts/build-connector-oci-artifact.mjs)",
	connector_key: profile.connector_key,
	connector_directory: name,
	data_connectors_revision: revision,
	manifest_sha256: sha(profileBytes),
	manifest_version: profile.version,
	bundle_sha256: bundleSha,
	esbuild_version: esbuild.version,
	externals_left: externals,
	signed: false,
};
writeFileSync(
	join(out, "provenance.json"),
	`${JSON.stringify(provenance, null, 2)}\n`,
);

// Slack-only asset: new URL("../../config/slackdump-api-config.toml", import.meta.url)
// resolves to <dirname(out)>/config/ from <out>/dist/collection-profile.mjs.
if (name === "slack") {
	const dest = join(dirname(out), "config");
	mkdirSync(dest, { recursive: true });
	cpSync(
		join(dcs, "packages/polyfill-connectors/config/slackdump-api-config.toml"),
		join(dest, "slackdump-api-config.toml"),
	);
}
console.log(JSON.stringify(provenance, null, 2));
