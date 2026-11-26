// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {sourceAnswer} from "../lib/source-status-words.ts";
import {agreementPractice} from "../sources/[connector]/agreement-practice.ts";
import {syncPractice} from "../history/practice.ts";
import {withCurrentSourceState} from "./current-source-state.ts";
import {syncDayProblem,syncDaySentence} from "./daily-syncs-view.tsx";
test("durable current gaps count as problems only on the newest shown day",()=>{
 const model=syncPractice("mixed",-360);if(model.history.mode!=="days") { throw new Error("fixture"); }
 const [stored]=model.history.data;assert.ok(stored);
 const row={...stored,missing:[]};
 const fixture=agreementPractice("retry-partial");assert.ok(fixture);
 const rows=withCurrentSourceState([row,{...row,day:"2020-01-01"}],[{...model.sources[0] as NonNullable<typeof model.sources[number]>,currentState:"Your messages didn’t come",currentProblem:true,currentAnswer:sourceAnswer(fixture.source,{now:new Date()})}]);
 const [current, earlier]=rows;assert.ok(current);assert.ok(earlier);
 assert.equal(syncDayProblem(current),true);assert.ok(syncDaySentence(current,"Gmail").includes("Your messages didn’t come"));assert.equal(syncDayProblem(earlier),true);
});
