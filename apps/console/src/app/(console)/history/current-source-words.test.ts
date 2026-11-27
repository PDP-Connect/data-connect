// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {buildSourcesDemoSummaries} from "../sources/sources-demo-data.ts";
import {sourceStatusWords} from "../lib/source-status-words.ts";
import {applyCurrentSourceWords} from "./current-source-words.ts";
test("stored collection gaps survive a successful last sync on the current history row",()=>{
 const [base]=buildSourcesDemoSummaries("mixed");assert.ok(base);
 const row={...base,collection_report:[{checkpoint:"unknown",collected:0,considered:"unknown" as const,coverage_condition:"retryable_gap" as const,forward_disposition:"resumable" as const,pending_detail_gaps:1,skipped:null,stream:"messages"}]};
 const source={id:row.connector_instance_id || row.connection_id,connector:row.connector_id,name:"Northwind",currentState:"",currentProblem:false,kinds:[{name:"messages",display:{label:"Your messages"}}]};
 applyCurrentSourceWords([row],[source]);
 assert.equal(source.currentProblem,true);assert.ok(source.currentState.includes(sourceStatusWords(row,{now:new Date()}).words));
 const ordinary={...source,currentState:"",currentProblem:false};applyCurrentSourceWords([base],[ordinary]);
 assert.ok(ordinary.currentState.includes(sourceStatusWords(base,{now:new Date()}).words));
});
