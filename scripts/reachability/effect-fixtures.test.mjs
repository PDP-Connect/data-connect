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
