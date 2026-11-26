// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {sourceKindLine} from "./source-kind-line.ts";
import {agreementPractice} from "../sources/[connector]/agreement-practice.ts";
for(const [state,line] of [["zero-summary-positive-tally","1"],["retry-partial","207 so far. Some didn't come at the last sync."],["archived-partial","428 so far. Some didn't come at the last sync."]] as const) test(`kind count and line: ${state}`,()=>{
 const source=agreementPractice(state)!.source;assert.equal(sourceKindLine(source,source.streams[0]!).line,line);
});
test("a kind without records always has a line, with and without a last-sync gap",()=>{
 const source=agreementPractice("maintainer-failure")!.source;
 assert.equal(sourceKindLine(source,"empty").line,"None yet");
 assert.equal(sourceKindLine({...source,collection_report:[{...agreementPractice("retry-partial")!.source.collection_report![0]!,stream:"empty",collected:0}]},"empty").line,"Didn't come at the last sync.");
});
