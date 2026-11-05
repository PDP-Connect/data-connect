// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPdppRemoteSurfaceTransport } from "./stream-viewer-remote-surface-transport.ts";

interface FetchCall {
  body: Record<string, unknown>;
  url: string;
}

function makeTransport() {
  const inputUrlRef = { current: "/input" };
  const viewportUrlRef = { current: "/viewport" };
  const clipboardUrlRef = { current: "/clipboard" };
  const presentationAttachmentReadyRef = { current: false };
  const logs: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const transport = createPdppRemoteSurfaceTransport({
    clipboardUrlRef,
    inputUrlRef,
    logDebug: (_event, payload) => {
      logs.push(payload ?? {});
    },
    presentationAttachmentReadyRef,
    viewportUrlRef,
  });
  transport.subscribe((message) => messages.push(message));
  return { clipboardUrlRef, inputUrlRef, logs, messages, presentationAttachmentReadyRef, transport, viewportUrlRef };
}

async function withFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
  work: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { body, url: String(input) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
}

test("Remote Surface pointer/text intents use one input POST without host-side remapping", async () => {
  const { messages, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(null, { status: 202 });
    },
    async () => {
      transport.send({
        action: "pointerdown",
        clickCount: 2,
        pointerType: "mouse",
        type: "pointer",
        x: 10,
        y: 20,
      });
      transport.send({ text: "typed once", type: "text" });
      await Promise.resolve();
    }
  );
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      {
        action: "pointerdown",
        clickCount: 2,
        pointerType: "mouse",
        type: "pointer",
        x: 10,
        y: 20,
      },
      { text: "typed once", type: "text" },
    ]
  );
  assert.equal(messages.length, 0);
});

test("viewport matching queues before attachment and emits one correlated acknowledgement", async () => {
  const { messages, presentationAttachmentReadyRef, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(JSON.stringify({ object: "run_interaction_stream_viewport_ack" }), {
        headers: { "Content-Type": "application/json" },
        status: 202,
      });
    },
    async () => {
      transport.send({ height: 600, requestId: 7, type: "viewport", width: 800 });
      await Promise.resolve();
      assert.equal(calls.length, 0);
      presentationAttachmentReadyRef.current = true;
      transport.setPresentationAttachmentReady(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, { height: 600, requestId: 7, type: "viewport", width: 800 });
  assert.deepEqual(messages, [
    {
      object: "run_interaction_stream_viewport_ack",
      requestId: 7,
      type: "viewport-applied",
    },
  ]);
});

test("SSE frames and keyboard focus enter the assembled session as inbound messages", () => {
  const { messages, transport } = makeTransport();
  transport.receiveSseMessage("frame", { data_base64: "AA==" });
  transport.receiveSseMessage("keyboard_focus", { element: { inputType: "text" }, focused: true });
  assert.deepEqual(messages, [
    { contentType: "image/jpeg", data: "AA==", sequence: 1, type: "frame" },
    {
      name: "keyboard_focus",
      payload: { element: { inputType: "text" }, focused: true },
      type: "backend_event",
    },
  ]);
});

test("remote selection reads use the clipboard endpoint and preserve request correlation", async () => {
  const { messages, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(JSON.stringify({ text: "selected text" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    },
    async () => {
      transport.send({ requestId: 12, type: "read_remote_selection" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  );
  assert.deepEqual(calls, [
    { body: { action: "remote_to_local", requestId: 12, type: "clipboard" }, url: "/clipboard" },
  ]);
  assert.deepEqual(messages, [{ requestId: 12, text: "selected text", type: "remote-selection" }]);
});

test("clipboard controls use the dedicated authenticated clipboard endpoint", async () => {
  const { transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response(JSON.stringify({ object: "run_interaction_stream_clipboard_ack" }), {
        headers: { "Content-Type": "application/json" },
        status: 202,
      });
    },
    async () => {
      assert.equal(await transport.sendClipboardText("manual text"), true);
    }
  );
  assert.deepEqual(calls, [
    { body: { action: "local_to_remote", text: "manual text", type: "clipboard" }, url: "/clipboard" },
  ]);
});

test("a clipboard read finishing after disposal cannot reach the replacement viewer", async () => {
  const { clipboardUrlRef, inputUrlRef, presentationAttachmentReadyRef, transport, viewportUrlRef } = makeTransport();
  const clipboardRead = Promise.withResolvers<string>();
  const oldPaste = clipboardRead.promise.then((text) => transport.sendClipboardText(text));
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response("{}", { status: 202 });
    },
    async () => {
      transport.dispose();
      clipboardUrlRef.current = "/replacement/clipboard";
      const replacement = createPdppRemoteSurfaceTransport({
        clipboardUrlRef,
        inputUrlRef,
        logDebug: () => undefined,
        presentationAttachmentReadyRef,
        viewportUrlRef,
      });
      clipboardRead.resolve("old paste");
      assert.equal(await oldPaste, false, "a disposed transport must refuse the old paste");
      assert.equal(await replacement.sendClipboardText("new paste"), true);
      replacement.dispose();
    }
  );
  assert.deepEqual(calls, [
    {
      body: { action: "local_to_remote", text: "new paste", type: "clipboard" },
      url: "/replacement/clipboard",
    },
  ]);
});

test("disposal is terminal for queued viewports, outbound input and inbound subscriptions", async () => {
  const { messages, presentationAttachmentReadyRef, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response("{}", { status: 202 });
    },
    async () => {
      transport.send({ height: 600, requestId: 1, type: "viewport", width: 800 });
      transport.dispose();
      transport.dispose();
      transport.subscribe((message) => messages.push(message));
      transport.setPresentationAttachmentReady(true);
      transport.send({ text: "late input", type: "text" });
      transport.send({ requestId: 2, type: "read_remote_selection" });
      transport.send({ height: 600, requestId: 3, type: "viewport", width: 800 });
      transport.receiveSseMessage("frame", { data_base64: "AA==" });
      transport.receiveSseMessage("keyboard_focus", { focused: true });
      assert.equal(await transport.sendClipboardText("late clipboard"), false);
      assert.equal(
        presentationAttachmentReadyRef.current,
        false,
        "disposed transport must not change shared readiness"
      );
    }
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(messages, []);
});

test("HTTP replies already in flight cannot notify a disposed viewer", async () => {
  const { messages, transport } = makeTransport();
  const viewportResponse = Promise.withResolvers<Response>();
  const selectionResponse = Promise.withResolvers<Response>();
  const clipboardResponse = Promise.withResolvers<Response>();
  await withFetch(
    (call) => {
      if (call.url === "/viewport") {
        return viewportResponse.promise;
      }
      return call.body.action === "remote_to_local" ? selectionResponse.promise : clipboardResponse.promise;
    },
    async () => {
      transport.setPresentationAttachmentReady(true);
      transport.send({ height: 600, requestId: 1, type: "viewport", width: 800 });
      transport.send({ requestId: 2, type: "read_remote_selection" });
      const clipboardAck = transport.sendClipboardText("already sent");
      transport.dispose();
      transport.subscribe((message) => messages.push(message));
      viewportResponse.resolve(new Response("{}", { status: 202 }));
      selectionResponse.resolve(new Response('{"text":"old selection"}', { status: 200 }));
      clipboardResponse.resolve(new Response("{}", { status: 202 }));
      assert.equal(await clipboardAck, false, "a late response cannot acknowledge a live clipboard operation");
      await new Promise((resolve) => setImmediate(resolve));
    }
  );
  assert.deepEqual(messages, [], "late replies must not reach existing or newly attached subscribers");
});

test("a live transport still follows endpoint refreshes", async () => {
  const { clipboardUrlRef, inputUrlRef, transport } = makeTransport();
  const calls: FetchCall[] = [];
  await withFetch(
    (call) => {
      calls.push(call);
      return new Response("{}", { status: 202 });
    },
    async () => {
      inputUrlRef.current = "/refreshed/input";
      clipboardUrlRef.current = "/refreshed/clipboard";
      transport.send({ text: "live input", type: "text" });
      assert.equal(await transport.sendClipboardText("live paste"), true);
    }
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/refreshed/input", "/refreshed/clipboard"]
  );
});
