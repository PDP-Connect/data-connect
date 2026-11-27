// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {sourceKindLine} from "./source-kind-line.ts";
import {agreementPractice} from "../sources/[connector]/agreement-practice.ts";
for(const [state,line] of [["zero-summary-positive-tally","1 record"],["retry-partial","207 records so far. Some didn't come at the last sync."],["archived-partial","428 records so far. Some didn't come at the last sync."]] as const) { test(`kind count and line: ${state}`,()=>{
 const model=agreementPractice(state);assert.ok(model);const {source}=model;
 const [kind]=source.streams;assert.ok(kind);assert.equal(sourceKindLine(source,kind).line,line);
}); }
test("a kind without records always has a line, with and without a last-sync gap",()=>{
 const model=agreementPractice("maintainer-failure");assert.ok(model);const {source}=model;
 const partial=agreementPractice("retry-partial");assert.ok(partial);const [report]=partial.source.collection_report ?? [];assert.ok(report);
 assert.equal(sourceKindLine(source,"empty").line,"None yet");
 assert.equal(sourceKindLine({...source,collection_report:[{...report,stream:"empty",collected:0}]},"empty").line,"Didn't come at the last sync.");
});

test("the latest sync's receipt prevents a false empty kind even without a current report",()=>{
 const model=agreementPractice("zero-summary-positive-tally");assert.ok(model);
 const source={...model.source,collection_report:[],stream_records:[{stream:"profile",record_count:0,retained_record_count:0,count_state:"known_zero" as const,last_updated:null}],last_run:{...model.source.last_run,run_id:"practice-sync",status:"succeeded",event_count:0,failure_reason:null,first_at:"2026-11-25T12:00:00Z",last_at:"2026-11-25T12:00:00Z",started_at:"2026-11-25T12:00:00Z",finished_at:"2026-11-25T12:00:00Z",collection_facts:{streams:[{stream:"profile",collected:1}]}}};
 assert.equal(sourceKindLine(source,"profile").line,"1 record");
});
