// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PackageProfile } from "../vendor/mcp-server/src/package-profile.ts";
import { RsClient } from "../vendor/mcp-server/src/rs-client.ts";

interface PackageMember {
	access_mode: string;
	active: boolean;
	connection_id: string | null;
	grant: {
		purpose: string;
		streams: readonly { readonly instance_ids: readonly string[]; readonly name: string }[];
	};
	grant_id: string;
	package_id: string;
	source: {
		connection_id?: string;
		connector_display_name?: string;
		display_name?: string;
		id: string;
		kind: "connector" | "provider_native";
	} | null;
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
		children: members.map(({ access_mode, active, connection_id, grant, grant_id, source, token }) => ({
			access_mode,
			active,
			connection_id: connection_id ?? source?.connection_id ?? null,
			grant_id,
			purpose: grant.purpose,
			source: source ? { ...source } : null,
			streams: grant.streams.map(({ name, instance_ids }) => ({
				name,
				instance_ids: [...instance_ids],
			})),
			rs: new RsClient({
				accessToken: token,
				fetch,
				providerUrl,
				...(userAgent === undefined ? {} : { userAgent }),
			}),
		})),
	};
}
