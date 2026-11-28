// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Builds the redirect URL for an authorization response (RFC 6749 4.1.2 and
// 4.1.2.1) with the RFC 9207 `iss` parameter. Every response that goes back to
// a client's redirect_uri, success or error, goes through here, so a new call
// site cannot forget `iss`. A client that checks `iss` compares it with the
// `issuer` of the authorization server metadata, so `issuer` must be the value
// the metadata route returns for the same request.

export interface AuthorizationResponseParams {
	readonly code?: string | null | undefined;
	readonly error?: string | null | undefined;
	readonly error_description?: string | null | undefined;
	readonly state?: string | null | undefined;
}

export function buildAuthorizationResponseUrl(
	redirectUri: string,
	issuer: string,
	params: AuthorizationResponseParams,
): string {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(params)) {
		if (value && name !== "state") {
			url.searchParams.set(name, value);
		}
	}
	if (params.state) {
		url.searchParams.set("state", params.state);
	}
	url.searchParams.set("iss", issuer);
	return url.toString();
}
