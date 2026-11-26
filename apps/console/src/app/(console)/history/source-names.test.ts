// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {sourceName} from "./source-names.ts";
test("a known connection gets its account name; a service-only read does not pick an account",()=>{
 const sources=[{id:"work",connector:"gmail",name:"Gmail (work)"},{id:"personal",connector:"gmail",name:"Gmail (personal)"}];
 assert.equal(sourceName(sources,"work","gmail"),"Gmail (work)");
 assert.equal(sourceName(sources,null,"gmail"),"Gmail");
 assert.equal(sourceName(sources,"gmail"),"Gmail");
});
