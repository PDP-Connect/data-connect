// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock,test } from "node:test";
import type { SyncEntry, RunStatusEnvelope } from "../../lib/ref-client.ts";
let status: RunStatusEnvelope | null = null;
const row: SyncEntry = {id:"old-sync",history_id:"1",connection_id:"mail-account",connector_id:"gmail",at:"2026-11-24T23:30:00.000Z",started_at:"2026-11-24T23:28:00.000Z",completed_at:"2026-11-24T23:30:00.000Z",outcome:"finished",records:14,trigger:null,cause:null};
mock.module("../../lib/ref-client.ts",{exports:{getRunStatus:async()=>status,getRunTimeline:async()=>null,listSyncHistory:async()=>({mode:"syncs",data:[row],has_more:false,next_cursor:null}),getConnectionSetupStatus:async()=>null}});
mock.module("../../history/server-day.ts",{exports:{readPersonOffset:async()=>120}});
mock.module("../../history/load-sources.ts",{exports:{loadHistorySources:async()=>[{id:"mail-account",connector:"gmail",name:"Gmail (work)"}],sourceName:()=>"Gmail (work)"}});
test("an old sync remains readable without retained events and does not invent kinds or a trigger",async()=>{
  const {loadOneSync}=await import("./load-one-sync.ts");
  const {model,offset}=await loadOneSync("old-sync",{});
  assert.equal(offset,120); assert.equal(model?.outcome,"finished"); assert.equal(model?.total,14);
  assert.equal(model?.kinds,null); assert.equal(model?.trigger,null); assert.equal(model?.connection,"mail-account");
});
test("the current handle's liveness overrides an older durable result",async()=>{
  status={object:"run_status",connector_id:"gmail",connector_instance_id:"mail-account",failure:null,links:{timeline:""},record_outcomes: { permanently_rejected: null, unaccounted_by_stream: {} },started_at:row.started_at,completed_at:null,status:"active",terminal_reason:null,trace_id:null};
  const {loadOneSync}=await import("./load-one-sync.ts");
  assert.equal((await loadOneSync("old-sync",{})).model?.outcome,"syncing");
});
