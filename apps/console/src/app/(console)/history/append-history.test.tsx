// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {JSDOM} from "jsdom";
import {AppendHistory,historyStartLabel} from "./append-history.tsx";
import {HistoryFilters,filterHref} from "./history-filters.tsx";
(globalThis as typeof globalThis & {React:typeof React;IS_REACT_ACT_ENVIRONMENT:boolean}).React=React;
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
test("append keeps earlier rows, adds the next page once, and states where history ends",async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:"https://console.example/syncs"});
  const previous={document:globalThis.document,window:globalThis.window,HTMLElement:globalThis.HTMLElement,Element:globalThis.Element};
  Object.assign(globalThis,{document:dom.window.document,window:dom.window,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element});
  const root=createRoot(document.getElementById("root") as HTMLElement);let calls=0;
  try{
    await act(async()=>root.render(<AppendHistory initial={{content:<p>First 50 rows</p>,next:"page2"}} label="Show more" load={async cursor=>{assert.equal(cursor,"page2");calls++;return{content:<p>Next 40 rows</p>,next:null,firstDay:"2026-08-13"}}} />));
    await act(async()=>{document.querySelector("button")?.click()});
    assert.match(document.body.textContent ?? "",/First 50 rowsNext 40 rowsHistory starts 13 Aug 2026\./);
    assert.equal(calls,1);assert.equal(document.querySelector("button"),null);
    await act(async()=>root.render(<AppendHistory initial={{content:<p>Updated first 50 rows</p>,next:"page2"}} label="Show more" load={async()=>({content:null,next:null})} />));
    assert.match(document.body.textContent ?? "",/Updated first 50 rowsNext 40 rows/);
    await act(async()=>root.render(<AppendHistory key="other-source" initial={{content:<p>Filtered first page</p>,next:null}} label="Show more" />));
    assert.match(document.body.textContent ?? "",/Filtered first page/);assert.doesNotMatch(document.body.textContent ?? "",/Next 40/);
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);dom.window.close()}
});
test("filters apply once on change and preserve native GET without scripts",async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:"https://console.example/syncs"});
  const previous={document:globalThis.document,window:globalThis.window};
  Object.assign(globalThis,{document:dom.window.document,window:dom.window});const root=createRoot(document.getElementById("root") as HTMLElement);
  try{
    await act(async()=>root.render(<HistoryFilters path="/syncs"><select name="connection_id" aria-label="Source"><option value="">All</option><option value="mail">Mail</option></select></HistoryFilters>));
    let submitted=0;const form=document.querySelector("form") as HTMLFormElement;form.requestSubmit=()=>{submitted++};
    const select=document.querySelector("select") as HTMLSelectElement;select.value="mail";
    await act(async()=>{select.dispatchEvent(new dom.window.Event("change",{bubbles:true}))});
    assert.equal(submitted,1);assert.equal(form.getAttribute("action"),"/syncs");
    assert.equal(filterHref("/syncs",new dom.window.FormData(form).entries()),"/syncs?connection_id=mail");
    assert.equal(historyStartLabel("2026-08-13"),"History starts 13 Aug 2026.");
  }finally{await act(async()=>root.unmount());Object.assign(globalThis,previous);dom.window.close()}
});
