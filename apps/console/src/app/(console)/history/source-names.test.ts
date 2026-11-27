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

test("service-only activity uses the same authored service name as source inventory",()=>{
 const sources=[{id:"budget",connector:"ynab",name:"Work budget",serviceName:"YNAB"},{id:"chat",connector:"whatsapp_web",name:"Work messages",serviceName:"WhatsApp"}];
 assert.equal(sourceName(sources,null,"ynab"),"YNAB");
 assert.equal(sourceName(sources,null,"whatsapp_web"),"WhatsApp");
});

test("a registry URL fallback never prints its underscore key",()=>{
 for(const host of ["registry.pdpp.dev","catalog.example"]) {
   const name=sourceName([],null,`https://${host}/connectors/apple_contacts`);
   assert.ok(!name.includes("_"));
 }
});
