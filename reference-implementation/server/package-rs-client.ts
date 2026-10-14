// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PackageProfile } from "../vendor/mcp-server/src/package-profile.ts";
import { RsClient } from "../vendor/mcp-server/src/rs-client.ts";

interface PackageMember {
	grant_id: string;
	token: string;
}

interface ClientOptions {
	fetch?: typeof globalThis.fetch;
	providerUrl: string;
	userAgent?: string;
}

/**
 * Build one single-bearer RsClient. Thin factory so the hosted-MCP route
 * adapter can construct a single-grant (`client`-token) RsClient against a
 * chosen fetch base (e.g. the internal RS base for self-calls) without
 * importing `@pdpp/mcp-server` internals directly.
 *
 * @param {object} args
 * @param {string} args.providerUrl   — fetch base for HTTP self-calls.
 * @param {string} args.accessToken   — the single grant bearer.
 * @param {Function} [args.fetch]
 * @param {string}  [args.userAgent]
 */
export function createRsClient({
	providerUrl,
	accessToken,
	fetch = globalThis.fetch,
	userAgent,
}: ClientOptions & {
	accessToken: string;
}): RsClient {
	if (!providerUrl) {
		throw new TypeError("createRsClient requires providerUrl");
	}
	return new RsClient({
		accessToken,
		fetch,
		providerUrl,
		...(userAgent === undefined ? {} : { userAgent }),
	});
}

export function createPackageProfile({
	providerUrl,
	members,
	fetch = globalThis.fetch,
	userAgent,
}: ClientOptions & { members: readonly PackageMember[] }): PackageProfile {
	if (!providerUrl) {
		throw new TypeError("createPackageProfile requires providerUrl");
	}
	if (members.length === 0) {
		throw new TypeError(
			"createPackageProfile requires at least one active member",
		);
	}
	return {
		children: members.map(({ grant_id, token }) => ({
			grant_id,
			rs: new RsClient({
				accessToken: token,
				fetch,
				providerUrl,
				...(userAgent === undefined ? {} : { userAgent }),
			}),
		})),
	};
}
