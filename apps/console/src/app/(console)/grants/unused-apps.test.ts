// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {buildAppPractice} from "./app-practice.ts";
import {unusedApps,removeUnusedApps} from "./unused-apps.ts";
test("bulk removal sends exactly unused app identities and names partial failures",async()=>{
 const apps=buildAppPractice("five").apps;
 apps[0]!.lastRead=new Date().toISOString(); apps[1]!.lastRead=null;apps[2]!.lastRead="2025-01-01T00:00:00Z";
 const unused=unusedApps(apps);assert.deepEqual(unused.map(app=>app.hrefId),[apps[1]!.hrefId,apps[2]!.hrefId]);
 let input: unknown;
 const result=await removeUnusedApps(unused,async value=>{input=value;return {ok:false,message:"Some access could not be removed.",failedGrantIds:apps[2]!.grantIds};});
 assert.deepEqual(input,{client_ids:[...apps[1]!.clientIds,...apps[2]!.clientIds]});
 assert.deepEqual(result.failedNames,[apps[2]!.name]);
});
test("an unavailable removal reports every targeted app without including used apps",async()=>{
 const apps=buildAppPractice("five").apps.slice(0,2);
 const result=await removeUnusedApps(apps,async()=>({ok:false,message:"Try again."}));
 assert.deepEqual(result.failedNames,apps.map(app=>app.name));
});
