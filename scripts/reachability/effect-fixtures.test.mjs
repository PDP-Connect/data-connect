// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createEffectFixtures } from "./effect-fixtures.ts";

function operation(host, kind, operation) {
	const effect = host.effects.find(
		(item) => item.kind === kind && item.operation === operation,
	);
	assert.ok(effect);
	return (input) =>
		effect.handle(input, {
			signal: new AbortController().signal,
			fixture: true,
		});
}

test("network exchange witnesses the actual local gate, then confirms fixture close independently", async () => {
	const canary = randomBytes(32).toString("hex");
	const witness = randomBytes(32);
	let visits = 0;
	const gate = net.createServer({ allowHalfOpen: true }, (socket) => {
		socket.on("data", () => {
			visits++;
			socket.end(witness);
		});
	});
	gate.listen(0, "localhost");
	await once(gate, "listening");
	const fixture = createEffectFixtures();
	try {
		const open = operation(fixture, "sdk-listener", "open");
		const opened = await open({
			options: {
				addr: `localhost:${gate.address().port}`,
				proto: "tcp",
				authtoken: canary,
			},
		});
		const payload = randomBytes(32);
		const result = await operation(
			fixture,
			"network",
			"exchange",
		)({
			endpoint: opened.url,
			transport: "tcp",
			bytes: payload.toString("base64"),
			pinnedCertificate: null,
			deadlineMs: Date.now() + 2000,
		});
		assert.deepEqual(Buffer.from(result.bytes, "base64"), witness);
		assert.notDeepEqual(Buffer.from(result.bytes, "base64"), payload);
		assert.equal(visits, 1);
		assert.equal(fixture.credentialSeen, true);
		assert.ok(
			!JSON.stringify({ result, ledger: fixture.ledger() }).includes(canary),
		);
		await operation(
			fixture,
			"sdk-listener",
			"close",
		)({ handle: opened.handle });
		assert.deepEqual(
			await operation(
				fixture,
				"sdk-listener",
				"read",
			)({ handle: opened.handle }),
			{ present: false },
		);
		await assert.rejects(
			operation(
				fixture,
				"network",
				"exchange",
			)({
				endpoint: opened.url,
				transport: "tcp",
				bytes: "",
				pinnedCertificate: null,
				deadlineMs: Date.now() + 1000,
			}),
			{ code: "unsupported" },
		);
	} finally {
		await fixture.close();
		gate.close();
		await once(gate, "close");
	}
});

test("network fetch reads a fresh gate witness and never a canned response", async () => {
	const witness = randomBytes(32).toString("hex");
	const canary = randomBytes(32).toString("hex");
	const gate = http.createServer((request, response) => {
		assert.equal(request.url, "/proof?fresh=yes");
		response.end(witness);
	});
	gate.listen(0, "localhost");
	await once(gate, "listening");
	const fixture = createEffectFixtures();
	try {
		const opened = await operation(
			fixture,
			"sdk-listener",
			"open",
		)({
			options: { addr: `localhost:${gate.address().port}`, authtoken: canary },
		});
		const result = await operation(
			fixture,
			"network",
			"fetch",
		)({ url: `${opened.url}/proof?fresh=yes`, method: "GET", headers: {} });
		assert.equal(
			Buffer.from(result.chunks[0].data, "base64").toString(),
			witness,
		);
		assert.ok(
			!JSON.stringify({ result, ledger: fixture.ledger() }).includes(canary),
		);
	} finally {
		await fixture.close();
		gate.closeAllConnections();
		gate.close();
		await once(gate, "close");
	}
});

test("process fixture accepts a transient credential but rejects argv/env copies", async () => {
	const { assertTransientProcessCredential } = await import(
		"./effect-fixtures.ts"
	);
	const credential = randomBytes(32).toString("hex");
	assert.doesNotThrow(() =>
		assertTransientProcessCredential({
			credential,
			program: "fixture-program",
			args: [],
		}),
	);
	assert.throws(
		() =>
			assertTransientProcessCredential({
				credential,
				program: "fixture-program",
				args: [credential],
			}),
		/process metadata/,
	);
	assert.throws(
		() =>
			assertTransientProcessCredential({
				credential,
				program: "fixture-program",
				args: [],
				env: { VALUE: credential },
			}),
		/process metadata/,
	);
});

test("SDK open returns only a typed safe failure code when the fixture declines", async () => {
  const canary = randomBytes(32).toString("hex")
  const fixture = createEffectFixtures({ sdkOpenFailure: true })
  const result = await operation(
    fixture,
    "sdk-listener",
    "open"
  )({
    options: {
      addr: "127.0.0.1:1",
      authtoken: canary,
    },
  })
  assert.deepEqual(result, { error: { code: "provider_unavailable" } })
  assert.equal(fixture.credentialSeen, false)
  assert.deepEqual(fixture.ledger(), [])
  assert.ok(
    !JSON.stringify({ result, ledger: fixture.ledger() }).includes(canary)
  )
  await fixture.close()
})

test("default HTTPS ports map proof requests to the same actual local gate", async () => {
  const witness = randomBytes(32).toString("hex")
  const gate = http.createServer((_request, response) => response.end(witness))
  gate.listen(0, "127.0.0.1")
  await once(gate, "listening")
  const fixture = createEffectFixtures()
  try {
    const { readFile } = await import("node:fs/promises")
    const data = JSON.parse(
      await readFile(
        new URL(
          "../../reference-implementation/test/fixtures/reachability/effects.json",
          import.meta.url
        ),
        "utf8"
      )
    )
    const written = await operation(
      fixture,
      "local-api",
      "request"
    )({
      path: data["local-api/request"].configPath,
      method: "POST",
      headers: { "If-Match": "0" },
      body: {
        Web: {
          "fixture.invalid:443": {
            Handlers: {
              "/": { Proxy: `http://127.0.0.1:${gate.address().port}` },
            },
          },
        },
      },
    })
    assert.equal(written.status, 200)
    const result = await operation(
      fixture,
      "network",
      "fetch"
    )({ url: "https://fixture.invalid/proof", method: "GET", headers: {} })
    assert.equal(
      Buffer.from(result.chunks[0].data, "base64").toString(),
      witness
    )
  } finally {
    await fixture.close()
    gate.close()
    await once(gate, "close")
  }
})

test("direct proof reads may reach only a target registered by an owned fixture effect", async () => {
  const witness = randomBytes(32).toString("hex");
  const gate = http.createServer((_request, response) => response.end(witness));
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  const fixture = createEffectFixtures();
  const target = `127.0.0.1:${gate.address().port}`;
  try {
    const opened = await operation(fixture, "sdk-listener", "open")({ options: { addr: target, authtoken: randomBytes(32).toString("hex") } });
    const result = await operation(fixture, "network", "fetch")({ url: `http://${target}/proof`, method: "GET", headers: {} });
    assert.equal(Buffer.from(result.chunks[0].data, "base64").toString(), witness);
    await assert.rejects(operation(fixture, "network", "fetch")({ url: "http://127.0.0.1:1/proof", method: "GET", headers: {} }), { code: "unsupported" });
    await operation(fixture, "sdk-listener", "close")({ handle: opened.handle });
    await assert.rejects(operation(fixture, "network", "fetch")({ url: `http://${target}/proof`, method: "GET", headers: {} }), { code: "unsupported" });
  } finally {
    await fixture.close();
    gate.close();
    await once(gate, "close");
  }
});

test("long-running spawn fixtures emit initial source output while the owned process remains live", async () => {
  const { readFile } = await import("node:fs/promises");
  const data = JSON.parse(await readFile(new URL("../../reference-implementation/test/fixtures/reachability/effects.json", import.meta.url), "utf8"));
  const fixture = createEffectFixtures();
  let opened;
  try {
    opened = await operation(fixture, "spawn", "run")({ program: "fixture-runtime", args: [...data["spawn/run"].publicArgs, `${data["spawn/run"].httpsPrefix}8443`, "http://127.0.0.1:1"], longRunning: true });
    assert.ok(opened.stdout.length + opened.stderr.length > 0, "The real driver arms initial collection only when source output arrives");
    assert.equal(opened.exitCode, null);
    assert.deepEqual(await operation(fixture, "spawn", "read")({ handle: opened.handle }), { present: true });
  } finally {
    await fixture.close();
  }
});

test("network proof transport preserves the requested authority at the real gate", async () => {
  const gate = http.createServer((request, response) => response.end(request.headers.host));
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  const fixture = createEffectFixtures();
  try {
    const opened = await operation(fixture, "sdk-listener", "open")({ options: { addr: `127.0.0.1:${gate.address().port}`, authtoken: randomBytes(32).toString("hex"), domain: "fixture.invalid" } });
    const result = await operation(fixture, "network", "fetch")({ url: `${opened.url}/proof`, method: "GET", headers: { host: "fixture.invalid" } });
    assert.equal(Buffer.from(result.chunks[0].data, "base64").toString(), "fixture.invalid");
  } finally {
    await fixture.close();
    gate.close();
    await once(gate, "close");
  }
});

test("network stream fixtures preserve independently observed chunks and their real arrival gaps", async () => {
  const frames = [0, 1, 2].map(sequence => `data: ${JSON.stringify({ sequence, witness: randomBytes(16).toString("hex") })}\n\n`);
  const gate = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frames[0]);
    setTimeout(() => response.write(frames[1]), 120);
    setTimeout(() => response.end(frames[2]), 240);
  });
  gate.listen(0, "127.0.0.1");
  await once(gate, "listening");
  const fixture = createEffectFixtures();
  try {
    const opened = await operation(fixture, "sdk-listener", "open")({ options: { addr: `127.0.0.1:${gate.address().port}`, authtoken: randomBytes(32).toString("hex") } });
    const result = await operation(fixture, "network", "fetch")({ url: `${opened.url}/stream`, method: "GET", headers: { accept: "text/event-stream" } });
    assert.equal(result.chunks.length, 3);
    assert.equal(Buffer.concat(result.chunks.map(chunk => Buffer.from(chunk.data, "base64"))).toString(), frames.join(""));
    assert.ok(result.chunks[1].delayMs >= 80);
    assert.ok(result.chunks[2].delayMs >= 80);
  } finally {
    await fixture.close();
    gate.close();
    await once(gate, "close");
  }
});

test("actual owned child exit withdraws only its foreground fixture configuration", async () => {
  const { readFile } = await import("node:fs/promises");
  const data = JSON.parse(await readFile(new URL("../../reference-implementation/test/fixtures/reachability/effects.json", import.meta.url), "utf8"));
  const fixture = createEffectFixtures();
  try {
    const opened = await operation(fixture, "spawn", "run")({ program: "fixture-runtime", args: [...data["spawn/run"].publicArgs, `${data["spawn/run"].httpsPrefix}8443`, "http://127.0.0.1:1"], longRunning: true });
    process.kill(opened.pid, "SIGTERM");
    const deadline = Date.now() + 2000;
    while ((await operation(fixture, "spawn", "read")({ handle: opened.handle })).present && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await operation(fixture, "spawn", "read")({ handle: opened.handle })).present, false);
    const recipe = data["recipe/probe"].cases.find(row => row.output === "serve-config");
    const observed = await operation(fixture, "recipe", "probe")({ recipe: { args: recipe.args } });
    assert.equal(Object.hasOwn(JSON.parse(observed.stdout).Foreground ?? {}, opened.handle), false);
    assert.equal(fixture.ledger().some(item => item.present), false);
  } finally { await fixture.close(); }
});
