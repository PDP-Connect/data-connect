import assert from "node:assert/strict";
import test from "node:test";

import {
	isLoopbackListenHost,
	resolveTrustedResourceBase,
	trustedMcpResource,
	trustedRsResource,
} from "../server/trusted-resource.ts";

test("trusted resource helpers keep mount resources on one canonical base", () => {
	const base = resolveTrustedResourceBase({
		configuredPublicUrl: "https://Example.COM/rs/api///",
		runtimeRsUrl: "http://127.0.0.1:7663",
		listenHost: "0.0.0.0",
	});

	assert.equal(base, "https://example.com/rs/api");
	assert.equal(trustedRsResource(base), "https://example.com/rs/api");
	assert.equal(trustedMcpResource(base), "https://example.com/rs/api/mcp");
});

test("trusted resource base accepts HTTPS and loopback HTTP published URLs", () => {
	const urls: Array<[string, string]> = [
		["https://rs.example.test/prefix", "https://rs.example.test/prefix"],
		["https://rs.example.test:443/prefix", "https://rs.example.test/prefix"],
		["http://localhost:7663/rs", "http://localhost:7663/rs"],
		["http://localhost:80/rs", "http://localhost/rs"],
		["http://127.4.5.6:7663/rs", "http://127.4.5.6:7663/rs"],
		["http://[::1]:7663/rs", "http://[::1]:7663/rs"],
	];
	for (const [configuredPublicUrl, expected] of urls) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl,
				runtimeRsUrl: "http://0.0.0.0:7663",
				listenHost: "0.0.0.0",
			}),
			expected,
		);
	}
});

test("runtime RS URL is trusted only for a loopback listener", () => {
	const runtimeRsUrl = "http://[::1]:7663/rs///";
	assert.equal(
		resolveTrustedResourceBase({
			configuredPublicUrl: null,
			runtimeRsUrl,
			listenHost: "::1",
		}),
		"http://[::1]:7663/rs",
	);

	assert.equal(
		resolveTrustedResourceBase({
			configuredPublicUrl: " \t ",
			runtimeRsUrl,
			listenHost: "localhost",
		}),
		"http://[::1]:7663/rs",
	);

	for (const listenHost of ["0.0.0.0", "::", "192.168.1.2"]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl: null,
				runtimeRsUrl,
				listenHost,
			}),
			null,
			`${listenHost} must not trust the runtime RS URL`,
		);
	}
});

test("loopback listener classification accepts only loopback literals", () => {
	for (const host of [
		"localhost",
		"LOCALHOST",
		"127.0.0.1",
		"127.9.8.7",
		"::1",
		"[::1]",
	]) {
		assert.equal(
			isLoopbackListenHost(host),
			true,
			`${host} should be loopback`,
		);
	}
	for (const host of [
		"localhost.localdomain",
		"localhost.",
		"127.attacker.example",
		"127.0.0.1.evil.test",
		"127.0.0.999",
		"127.1",
		"0.0.0.0",
		"::",
		"::ffff:127.0.0.1",
		"192.168.1.2",
		"10.0.0.2",
	]) {
		assert.equal(
			isLoopbackListenHost(host),
			false,
			`${host} should not be loopback`,
		);
	}
	assert.equal(isLoopbackListenHost(undefined), false);
	assert.equal(isLoopbackListenHost(null), false);
	assert.equal(isLoopbackListenHost(127 as never), false);
});

test("invalid published URLs fail closed even when runtime fallback is available", () => {
	for (const configuredPublicUrl of [
		"javascript:alert(1)",
		"file:///etc/passwd",
		"http://rs.example.test",
		"https://user:secret@rs.example.test",
		"https://@rs.example.test",
		"https:/@rs.example.test",
		"https://rs.example.test/path?query=1",
		"https://rs.example.test/path?",
		"https://rs.example.test/path#fragment",
		"https://rs.example.test/path#",
	]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl,
				runtimeRsUrl: "http://localhost:7663/rs/",
				listenHost: "localhost",
			}),
			null,
			`${configuredPublicUrl} must not be trusted`,
		);
	}
});

test("explicit invalid published URLs fail closed on a loopback listener", () => {
	for (const configuredPublicUrl of [
		"https://resource.example?x=1",
		"https://resource.example#fragment",
		"https://user:secret@resource.example",
		"javascript:alert(1)",
		"file:///etc/passwd",
		"http://resource.example",
		"http://127.attacker.example/rs",
	]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl,
				runtimeRsUrl: "http://localhost:1234",
				listenHost: "127.0.0.1",
			}),
			null,
			`${configuredPublicUrl} must not fall back to the runtime URL`,
		);
	}
});

test("both URL userinfo forms are rejected", () => {
	for (const configuredPublicUrl of [
		"https:/@example.com",
		"https://@example.com",
	]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl,
				runtimeRsUrl: "http://localhost:1234",
				listenHost: "127.0.0.1",
			}),
			null,
		);
	}
});

test("published URLs must use unambiguous absolute HTTP syntax", () => {
	for (const configuredPublicUrl of [
		"https:\\@h",
		"https:////@h",
		"https:/\\/@h",
		"https:\\\\h",
		"https:/h",
		"https:h",
		"HTTPS://H",
		"https://exa\tmple.com",
		"https://example.com\n",
		"https:\\u@h",
		"https:\\:p@h",
	]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl,
				runtimeRsUrl: "http://localhost:1234",
				listenHost: "127.0.0.1",
			}),
			null,
			`${JSON.stringify(configuredPublicUrl)} must not be trusted`,
		);
	}

	assert.equal(
		resolveTrustedResourceBase({
			configuredPublicUrl: "https://H",
			runtimeRsUrl: "http://localhost:1234",
			listenHost: "127.0.0.1",
		}),
		"https://h",
	);
});

test("absent published URL falls back only for a loopback listener", () => {
	for (const configuredPublicUrl of [undefined, null, "", " \t "]) {
		const options = {
			runtimeRsUrl: "http://localhost:1234",
			listenHost: "127.0.0.1",
			...(configuredPublicUrl === undefined ? {} : { configuredPublicUrl }),
		};
		assert.equal(resolveTrustedResourceBase(options), "http://localhost:1234");
		assert.equal(
			resolveTrustedResourceBase({ ...options, listenHost: "0.0.0.0" }),
			null,
		);
		assert.equal(
			resolveTrustedResourceBase({ ...options, listenHost: undefined }),
			null,
		);
		assert.equal(
			resolveTrustedResourceBase({ ...options, listenHost: null }),
			null,
		);
	}
});

test("runtime URL must itself be valid and loopback", () => {
	for (const runtimeRsUrl of [
		"https://remote.example/rs",
		"http://192.168.1.2/rs",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"http://localhost/rs?x=1",
		"http://localhost/rs#fragment",
		"http://user:secret@localhost/rs",
	]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl: null,
				runtimeRsUrl,
				listenHost: "127.0.0.1",
			}),
			null,
			`${runtimeRsUrl} must not be trusted as a runtime RS URL`,
		);
	}
});

test("non-loopback HTTP published URLs fail closed on exposed listeners", () => {
	for (const configuredPublicUrl of [
		"http://192.168.1.2/rs",
		"http://[::ffff:127.0.0.1]/rs",
	]) {
		assert.equal(
			resolveTrustedResourceBase({
				configuredPublicUrl,
				runtimeRsUrl: "http://localhost:1234",
				listenHost: "0.0.0.0",
			}),
			null,
			`${configuredPublicUrl} must not be published as a trusted resource`,
		);
	}
});

test("nullish options fail closed", () => {
	assert.equal(resolveTrustedResourceBase(null), null);
	assert.equal(resolveTrustedResourceBase(undefined), null);
});

test("non-string configured URLs fail closed", () => {
	assert.equal(
		resolveTrustedResourceBase({
			configuredPublicUrl: {
				toString: () => "https://example.com",
			},
			runtimeRsUrl: "http://localhost:1234",
			listenHost: "127.0.0.1",
		}),
		null,
	);
});

test("missing or unusable resource URLs fail closed", () => {
	assert.equal(
		resolveTrustedResourceBase({
			configuredPublicUrl: null,
			runtimeRsUrl: null,
			listenHost: "localhost",
		}),
		null,
	);
	assert.equal(
		resolveTrustedResourceBase({
			configuredPublicUrl: "http://remote.example.test",
			runtimeRsUrl: "http://remote.example.test:7663",
			listenHost: "remote.example.test",
		}),
		null,
	);
});
