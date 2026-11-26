// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buildRecoveryDemoModel } from "./source-detail-demo-data.ts";
import type { SourceStatusRow } from "../../lib/source-status-words.ts";
import type { RefConnectorSummary, RefRequiredAction } from "../../lib/ref-client.ts";

const SHAPES: Record<string,{row:SourceStatusRow;failed?:boolean;gap?:boolean;off?:boolean;device?:boolean;bare?:boolean;held?:number;canonical?:number;copied?:number;reason?:string;stream?:string}> = {
  "maintainer-failure": {row:13,failed:true},
  "schedule-off-failure": {row:16,failed:true,off:true},
  "maintainer-partial": {row:13,gap:true},
  "archived-partial": {row:1,gap:true},
  "zero-summary-positive-tally": {row:16,off:true,stream:"profile",held:1,canonical:0,copied:1},
  "retry-partial": {row:16,failed:true,gap:true,held:207,copied:442},
  "retry-web": {row:16,failed:true,gap:true},
  "unfinished-sign-in": {row:13,failed:true,gap:true,reason:"assistance_timed_out"},
  "maintainer-unknown-kind": {row:13,failed:true,gap:true},
  "maintainer-copy-failure": {row:13,failed:true,gap:true,reason:"stream_collection_failed"},
  "device-unsent": {row:8,device:true},
  "device-stalled-no-owner-step": {row:8,device:true,bare:true},
  "install-again": {row:4},
};
/** Invented accounts with the stored shapes in the final agreement ledger. */
export const AGREEMENT_STATES = Object.keys(SHAPES);
export function agreementPractice(state:string) {
  const shape=SHAPES[state];
  if(!shape) {return null;}
  const model=buildRecoveryDemoModel(shape.row,false);
  const id=`practice-agreement-${state}`;
  const kind=shape.stream ?? "messages";
  const held=shape.held ?? 428;
  const canonical=shape.canonical ?? held;
  const reason=shape.reason ?? "connector_reported_failed";
  let status="succeeded";
  if(shape.failed) {status="failed";}
  if(shape.device || shape.row === 4) {status="skipped";}
  const records=[{stream:kind,last_updated:null,record_count:canonical,retained_record_count:held,count_state:"known" as const}];
  const source:RefConnectorSummary={...model.source,connection_id:id,connector_instance_id:id,connector_id:"northwind",display_name:"Northwind (practice account)",connector_display_name:"Northwind",source_kind:"account",source_visibility:"active",status:"active",streams:[kind],stream_records:records,total_records:canonical,total_records_state:"known",last_run:{run_id:"practice-sync",status,failure_reason:reason,terminal_reason:reason,event_count:0,started_at:"2026-11-25T12:00:00Z",finished_at:null,first_at:"2026-11-25T12:00:00Z",last_at:"2026-11-25T12:00:00Z"},collection_report:[],local_device_progress:null};
  if(shape.gap || shape.copied) {
    source.collection_report=[{stream:kind,checkpoint:"unknown",collected:shape.copied ?? 14,considered:"unknown",coverage_condition:shape.gap?"terminal_gap":"complete",forward_disposition:shape.gap?"terminal":"complete",pending_detail_gaps:0,skipped:null}];
  }
  const maintainer:RefRequiredAction={affects:[kind],audience:"maintainer",kind:"code_fix",cta:"Fix the copy",surface:{kind:"maintainer"},satisfied_when:{kind:"none"},terminal:true,urgency:"soon"};
  let actions:RefRequiredAction[]=[];
  if(shape.row === 13) {actions=[maintainer];}
  if(shape.off) {
    source.owner_state={evidence_as_of:null,owner_of_state:"owner",posture:"observed",resolver:"owner_paused"};
    actions=[{...maintainer,audience:"owner",kind:"reattach_schedule",cta:"Resume schedule",surface:{kind:"schedule"},satisfied_when:{kind:"schedule_attached_and_enabled"},terminal:false}];
  }
  if(shape.row === 1) {source.source_visibility="archived";source.status="paused";}
  if(shape.device) {
    source.source_kind="local_device";
    source.local_device_progress={last_heartbeat_at:null,last_heartbeat_status:null,last_ingest_at:null,source_count:1,records_pending:4959,device_name:"Practice computer",source_instance_id:"practice-instance"};
    source.owner_state={evidence_as_of:null,owner_of_state:"owner",posture:"observed",resolver:"needs_owner"};
    actions=shape.bare ? [] : [{...maintainer,audience:"owner",kind:"add_info",cta:"See what to do on that computer",surface:{kind:"local_device"},terminal:false,remediation:buildRecoveryDemoModel(16).connectionRenderedVerdict?.required_actions[0]?.remediation}];
    if(shape.bare) {source.connection_health={...source.connection_health,conditions:[{id:"outbox",type:"outbox",origin:"collector",message:"Records could not be sent.",severity:"error",sensitivity:"owner",expires_at:null,observed_at:null,status:"false",reason:"dead_lettered",remediation:{action:"clear_backlog",label:"Inspect the local collector backlog",retryable:false,target:null}}]};}
  }
  if(source.rendered_verdict) {source.rendered_verdict={...source.rendered_verdict,required_actions:actions};}
  return {...model,connectionRenderedVerdict:source.rendered_verdict ?? null,connectionPrimaryAction:actions.find(item=>item.audience === "owner") ?? null,sourceInstances:model.sourceInstances.map(device=>({...device,connector_instance_id:id,source_instance_id:"practice-instance",device_display_name:"Practice computer",records_pending:source.local_device_progress?.records_pending ?? null})),connectionId:id,connectorInstanceId:id,connectorId:"northwind",displayName:source.display_name,source,latestKnownGaps:[],streams:records.map(record=>({...record,name:record.stream,object:"stream" as const})),overview:{...model.overview,localDeviceProgress:source.local_device_progress}};
}
