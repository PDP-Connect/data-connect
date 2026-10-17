// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Example third-party clients that tests sign in as. The server does not
 * pre-register them; a test that needs them passes
 * `preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS` to
 * `startServer`, or seeds them itself.
 */

import {
  DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
  type DefaultPreRegisteredPublicClient,
} from "../../server/reference-local-defaults.ts";

export const DEMO_PRE_REGISTERED_PUBLIC_CLIENTS: readonly DefaultPreRegisteredPublicClient[] = Object.freeze([
  {
    client_id: "longview",
    metadata: { client_name: "Longview", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "longview_planning_v1",
    metadata: { client_name: "Longview", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "cli_longview",
    metadata: {
      client_name: "Longview CLI",
      token_endpoint_auth_method: "none",
    },
  },
  {
    client_id: "concert_recommendation_app",
    metadata: {
      client_name: "Concert Recommendation App",
      token_endpoint_auth_method: "none",
    },
  },
]);

/** The product clients plus the demo clients, as mutable entries. */
export const TEST_PRE_REGISTERED_PUBLIC_CLIENTS = [
  ...DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
  ...DEMO_PRE_REGISTERED_PUBLIC_CLIENTS,
].map((client) => ({ ...client, metadata: { ...client.metadata } }));
