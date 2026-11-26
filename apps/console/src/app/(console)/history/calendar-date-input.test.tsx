// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {JSDOM} from "jsdom";
import {CalendarDateInput} from "./calendar-date-input.tsx";
Object.assign(globalThis,{React});
for(const [value,display] of [["","Choose a date"],["2026-11-25","25 Nov 2026"]]) {
 test(`calendar date keeps its native ISO contract: ${value}`,()=>{
  const dom=new JSDOM(renderToStaticMarkup(<form><CalendarDateInput name="date" defaultValue={value} aria-label="Date" /></form>));
  const input=dom.window.document.querySelector("input");assert.ok(input);
  assert.equal(input.type,"date");assert.equal(input.value,value);
  assert.equal(new dom.window.FormData(input.form ?? undefined).get("date"),value);
  assert.ok(dom.window.document.body.textContent?.includes(display ?? ""));dom.window.close();
 });
}
