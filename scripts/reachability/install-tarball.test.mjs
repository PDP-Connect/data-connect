// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installTarball } from "./install-tarball.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "gozar-gate-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = join(root, "input");
	await mkdir(pkg);
	await writeFile(join(pkg, "package.json"), JSON.stringify({name:"@tnunamak/gozar",version:"1.0.0"}));
	await writeFile(join(pkg, "index.js"), "export const inert = true;\n");
	const env = {...process.env, npm_config_cache:join(root,"npm-cache"), npm_config_offline:"true", npm_config_audit:"false", npm_config_fund:"false"};
	// The pack output format differs across npm majors; read the one tarball from its own folder.
	const packed = join(root, "packed");
	await mkdir(packed);
	const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packed], {cwd:pkg,env,encoding:"utf8"});
	assert.equal(result.status,0,result.stderr);
	const tarballs = (await readdir(packed)).filter((name) => name.endsWith(".tgz"));
	assert.equal(tarballs.length, 1);
	const path = join(packed, tarballs[0]);
	const bytes = await readFile(path);
	return {opts:{cwd:root,env:{...env,GOZAR_TARBALL:path,GOZAR_TARBALL_SHA256:digest(bytes),GOZAR_SOURCE_SHA:"1".repeat(40)},diskFloor:async()=>{}},bytes};
}

test("install uses a private staged copy and each success repoints the link", async t => {
	const {opts,bytes} = await fixture(t);
	const a = await installTarball(opts);
	assert.equal(a.status,0);
	const receipt = JSON.parse(await readFile(join(a.prefix,"receipt.json"),"utf8"));
	assert.equal(receipt.sha256,digest(bytes));
	assert.equal(receipt.sourceSha,opts.env.GOZAR_SOURCE_SHA);
	assert.equal(receipt.artifact,join(a.prefix,"artifact.tgz"));
	assert.notEqual(receipt.artifact,opts.env.GOZAR_TARBALL);
	assert.deepEqual(await readFile(receipt.artifact),bytes);
	const b = await installTarball(opts);
	assert.equal(b.status,0);
	assert.notEqual(a.prefix,b.prefix);
	assert.equal(await readlink(join(opts.cwd,"node_modules/@tnunamak/gozar")),join(b.prefix,"node_modules/@tnunamak/gozar"));
});

test("failed install leaves no prefix receipt or link", async t => {
	const {opts} = await fixture(t);
	const bad = Buffer.from("invalid archive");
	await writeFile(opts.env.GOZAR_TARBALL,bad);
	opts.env.GOZAR_TARBALL_SHA256 = digest(bad);
	assert.notEqual((await installTarball(opts)).status,0);
	assert.deepEqual(await readdir(join(opts.cwd,"node_modules")),[]);
});

test("npm consumes staged bytes even if the input changes after staging", async t => {
	const {opts,bytes} = await fixture(t);
	const result = await installTarball({...opts, run(command,args,options) {
		if (command === "npm") writeFileSync(opts.env.GOZAR_TARBALL,"discarded input");
		return spawnSync(command,args,options);
	}});
	assert.equal(result.status,0);
	const receipt = JSON.parse(await readFile(join(result.prefix,"receipt.json"),"utf8"));
	assert.equal(receipt.sha256,digest(bytes));
	assert.deepEqual(await readFile(receipt.artifact),bytes);
});

test("an altered installed file is rejected before publication", async t => {
	const {opts} = await fixture(t);
	await assert.rejects(installTarball({...opts,run(command,args,options) {
		const result = spawnSync(command,args,options);
		if (command === "npm" && result.status === 0)
			writeFileSync(join(args[1],"node_modules/@tnunamak/gozar/index.js"),"// different inert contents\n");
		return result;
	}}), /Installed package differs.*changed index\.js/);
	assert.deepEqual(await readdir(join(opts.cwd,"node_modules")),[]);
});
