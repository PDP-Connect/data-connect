// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {mock,test} from "node:test";
import {buildAppPractice} from "../grants/app-practice.ts";
const registration=buildAppPractice("mixed").registrations[0]!;
let query: Record<string,unknown>={};
mock.module("../lib/ref-client.ts",{exports:{listAppAccess:async()=>({data:[registration]}),listAppHistory:async(input:Record<string,unknown>)=>{query=input;return {mode:"days",identities:[{...registration,client_id:"repeat",sources:[]},{...registration,client_id:"never-allowed",client_name:"Claude",return_host:"claude.ai",sources:[]}],data:[registration.client_id,"repeat","never-allowed"].map(client_id=>({day:"2026-11-25",client_id,reads:3,across_sources:3,sources:[],permission_refusals:0,last_at:"2026-11-25T12:00:00.000Z"})),changes:[],has_more:false,next_cursor:null};}}});
mock.module("../history/server-day.ts",{exports:{readPersonOffset:async()=>120}});
mock.module("../history/load-sources.ts",{exports:{loadHistorySources:async()=>[]}});
test("app filtering includes repeated registrations that have history but no permission",async()=>{
  const {loadActivity}=await import("./load-activity.ts");
  const result=await loadActivity({app:"practice-access"});
  assert.equal(result.history.mode,"days");
  assert.equal(result.history.data.length,2);
  assert.equal(query.client_ids,undefined);
});
test("an app without a permission can still be selected from its stored identity",async()=>{
  const {loadActivity}=await import("./load-activity.ts");
  const result=await loadActivity({app:"never-allowed"});
  assert.equal(result.history.data.length,1);
});
