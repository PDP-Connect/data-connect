// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { TimelineEnvelope, RunStatusEnvelope, SpineEvent } from "../../lib/ref-client.ts";
export function technicalPractice(id: string, now = Date.now()): [TimelineEnvelope,RunStatusEnvelope] {
  const start = new Date(now-180_000).toISOString(); const end = new Date(now-60_000).toISOString();
  const event = (type: string,at: string,data: Record<string,unknown>): SpineEvent => ({ actor_id:"northwind",actor_type:"runtime",client_id:null,data,event_id:`sample-${type}`,event_type:type,grant_id:null,interaction_id:null,object_id:id,object_type:"run",occurred_at:at,recorded_at:at,request_id:null,run_id:id,scenario_id:null,status:"succeeded",stream_id:null,subject_id:null,subject_type:null,token_id:null,trace_id:"sample-activity",version:"1" });
  return [{ object:"run_timeline",trace_id:"sample-activity",event_count:2,truncated:false,terminal_status:"completed",events:[event("run.started",start,{connector_instance_id:"practice-source-4"}),event("run.completed",end,{collection_facts:{streams:[{stream:"messages",collected:14}]}})] },{object:"run_status",run_id:id,connector_id:"northwind",connector_instance_id:"practice-source-4",failure:null,links:{timeline:`/_ref/runs/${id}/timeline`},record_outcomes: { permanently_rejected: 0, unaccounted_by_stream: {} },started_at:start,completed_at:end,status:"completed",terminal_reason:null,trace_id:"sample-activity"}];
}
