// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SyncDayRows} from "../syncs/day/sync-day-view.tsx";
import {readPractice} from "./practice.ts";
import {groupReadLines} from "../audit/day/read-day-rows.tsx";
import {readSentence} from "../audit/day/read-sentence.ts";

Object.assign(globalThis,{React});
test("failed rows do not say Nothing to copy and unknown missing kinds use a sentence",()=>{
 const html=renderToStaticMarkup(React.createElement(SyncDayRows,{name:"Gmail",day:"2026-11-25",offset:-360,rows:[{id:"run",history_id:"1",connection_id:"mail",connector_id:"gmail",at:"2026-11-25T12:00:00Z",started_at:"2026-11-25T11:58:00Z",completed_at:null,outcome:"failed",records:0,trigger:"scheduled",cause:null,missing:[{stream:null,retryable:false}]}]}));
 assert.ok(!html.includes("Nothing to copy"));assert.ok(html.includes("Some records didn’t come."));
});
test("search variants with the same meaning merge and field reads use the singular kind",()=>{
 const history=readPractice("kinds");if(history.mode!=="reads") { throw new Error("fixture"); }
 const searches=history.data.filter(read=>read.shape?.startsWith("search")).slice(0,3);
 assert.equal(groupReadLines(searches).length,1);
 const fieldRead=history.data.find(read=>read.shape==="field_window"); assert.ok(fieldRead);
 assert.equal(readSentence(fieldRead,"Gmail","Messages"),"Read part of one message from Gmail");
});
