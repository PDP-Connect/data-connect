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
// Every command below also needs --expect-revision <full sha of that checkout>; the build refuses otherwise.
// The 0.6.0 emitter is built from 97536ad49, while c82718d4 vendors 21e0386d; the only slack difference
// is a 5-line observeProgress() change in runSlackdump.
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
//   apple_contacts, spotify, github (data-connectors 97536ad49, same flags as the 0.6.0 slack build, with
//   --connector <name>, --connector-dir <checkout>/packages/polyfill-connectors/connectors/<name> and
//   --manifest <checkout>/packages/polyfill-connectors/manifests/<name>.json):
//     apple_contacts -> bundle sha256 11777c08835a12e0ad04f62645c7315aae6918399964421a2072b8358ad009f7
//     github         -> bundle sha256 b33a2dcaecfe91e4b23f051800fe4814fed96f5b308e430bafec205e2139d9c7
//     spotify        -> bundle sha256 7df5838bda8dcd69ddb48a90177c814dd538b29c0b73f95aef80ba42952e7ef1
//
// usage: node build-local-source.mjs --dcs <checkout> --connector <dir name> --out <dir>
//          [--manifest <path>] [--esbuild <path to esbuild main.js>] [--external a,b]
//          [--connector-dir <dir>] [--contract <host-runtime-contract.mjs>]
//          --expect-revision <40-hex sha>   (required: the build refuses unless the checkout's HEAD is this
//                                            commit and its tracked tree is clean)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

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
const expectRevision = arg("--expect-revision");
const headRevision = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: dcs,
	encoding: "utf8",
}).trim();
if (headRevision !== expectRevision) {
	throw new Error(
		`refusing to build: ${dcs} is at ${headRevision}, expected ${expectRevision}`,
	);
}
const dirty = execFileSync(
	"git",
	["status", "--porcelain", "--", ".", ":!node_modules"],
	{ cwd: dcs, encoding: "utf8" },
).trim();
if (dirty) {
	throw new Error(
		`refusing to build: ${dcs} has uncommitted changes:\n${dirty}`,
	);
}
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

const revision = headRevision;
const bundleSha = sha(readFileSync(outfile));

// Inventory of what the bundle was built from, taken from the esbuild metafile: in-repo sources
// (hashed) and third-party packages (name, version, declared license, shipped license texts).
const sourceInventory = [];
const packages = new Map();
for (const input of Object.keys(build.metafile.inputs).sort()) {
	const abs = join(dcs, input);
	const nm = input.lastIndexOf("node_modules/");
	if (nm === -1) {
		if (existsSync(abs)) {
			sourceInventory.push({
				path: input,
				sha256: `sha256:${sha(readFileSync(abs))}`,
			});
		}
		continue;
	}
	// The package root is node_modules/<name> or node_modules/@scope/<name> after the last node_modules/.
	const parts = input.slice(nm + "node_modules/".length).split("/");
	const pkgName = parts[0].startsWith("@")
		? `${parts[0]}/${parts[1]}`
		: parts[0];
	const root = join(
		abs.slice(0, abs.lastIndexOf("node_modules/") + "node_modules/".length),
		pkgName,
	);
	if (!packages.has(root)) {
		const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const texts = readdirSync(root)
			.filter((f) => /^(licen[sc]e|notice|copying)/i.test(f))
			.sort()
			.map((f) => ({ file: f, text: readFileSync(join(root, f), "utf8") }));
		packages.set(root, {
			name: meta.name,
			version: meta.version,
			license:
				typeof meta.license === "string"
					? meta.license
					: (meta.license?.type ?? JSON.stringify(meta.licenses ?? null)),
			texts,
			inputs: 0,
		});
	}
	packages.get(root).inputs += 1;
}
const thirdParty = [...packages.values()].sort((x, y) =>
	x.name.localeCompare(y.name),
);
const provenance = {
	generated_file_notice:
		"Local-source layout build (scratch builder). Not signed. Rebuild with build-local-source.mjs.",
	builder:
		"build-local-source.mjs (esbuild settings copied from scripts/build-connector-oci-artifact.mjs)",
	connector_key: profile.connector_key,
	connector_directory: name,
	version: profile.version,
	source: {
		repository: "https://github.com/PDP-Connect/data-connectors",
		revision,
		connector_path: relative(dcs, connectorDir),
	},
	build_command: `node build-local-source.mjs ${process.argv
		.slice(2)
		.map((a) =>
			a.replaceAll(dcs, "<checkout>").replaceAll(dirname(dcs), "<work>"),
		)
		.join(" ")}`,
	dependency_install: lstatSync(join(dcs, "node_modules")).isSymbolicLink()
		? "node_modules is a symlink to another checkout's install; the third-party versions below are what was bundled"
		: "node_modules installed in the checkout",
	manifest_sha256: `sha256:${sha(profileBytes)}`,
	bundle_sha256: `sha256:${bundleSha}`,
	esbuild_version: esbuild.version,
	externals_left: externals,
	source_inventory: sourceInventory,
	third_party_packages: thirdParty.map(
		({ name: n, version, license, inputs }) => ({
			name: n,
			version,
			license,
			bundled_inputs: inputs,
		}),
	),
	signed: false,
};
writeFileSync(
	join(out, "provenance.json"),
	`${JSON.stringify(provenance, null, 2)}\n`,
);
mkdirSync(join(out, "licenses"), { recursive: true });
writeFileSync(
	join(out, "licenses", "LICENSE"),
	readFileSync(join(dcs, "LICENSE")),
);
const notice = [
	readFileSync(join(dcs, "NOTICE"), "utf8").trimEnd(),
	"",
	"This bundle also contains third-party packages, found in the esbuild metafile of the build.",
	"Each package's own license and notice files follow.",
	"",
	...thirdParty.flatMap((pkg) => [
		"=".repeat(78),
		`${pkg.name}@${pkg.version} (${pkg.license})`,
		"=".repeat(78),
		...(pkg.texts.length
			? pkg.texts.flatMap((t) => [`--- ${t.file} ---`, t.text.trimEnd(), ""])
			: [
					"(no license file shipped in the package; license field above is from its package.json)",
					"",
				]),
	]),
].join("\n");
writeFileSync(join(out, "licenses", "NOTICE"), `${notice}\n`);

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
console.log(
	JSON.stringify(
		{
			...provenance,
			source_inventory: `${sourceInventory.length} files`,
			third_party_packages: `${thirdParty.length} packages`,
		},
		null,
		2,
	),
);
