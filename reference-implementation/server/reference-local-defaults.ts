// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference-local convenience defaults.
 *
 * These values are **not** part of the PDPP protocol and are **not** part of
 * the published PDPP contract. They exist so that a developer running the
 * local reference stack can bring up the AS, the dashboard, and the example
 * third-party client without manually provisioning an initial access token
 * or pre-registering the first-party clients. Any production-style deployment
 * is expected to override these through environment variables.
 */

export const DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-local-initial-access-token";

export interface DefaultPreRegisteredPublicClient {
  readonly client_id: string;
  readonly metadata: {
    readonly client_name: string;
    readonly token_endpoint_auth_method: string;
  };
}

/** The client the console mints its owner bearer as. */
export const CONSOLE_OWNER_CLIENT_ID = "dataconnect-console";

/** The client the connector runtime mints its owner bearer as. */
export const CONNECTOR_RUNTIME_OWNER_CLIENT_ID = "dataconnect-connector-runtime";

/**
 * Clients product code signs in as: the published `pdpp` CLI, the console's
 * operator bootstrap and owner bearer, and the connector runtime.
 */
export const DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS: readonly DefaultPreRegisteredPublicClient[] = Object.freeze([
  {
    client_id: "pdpp_cli",
    metadata: { client_name: "PDPP CLI", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "pdpp-web-dashboard",
    metadata: {
      client_name: "PDPP Reference Dashboard",
      token_endpoint_auth_method: "none",
    },
  },
  {
    client_id: CONSOLE_OWNER_CLIENT_ID,
    metadata: {
      client_name: "DataConnect console",
      token_endpoint_auth_method: "none",
    },
  },
  {
    client_id: CONNECTOR_RUNTIME_OWNER_CLIENT_ID,
    metadata: {
      client_name: "DataConnect connector runtime",
      token_endpoint_auth_method: "none",
    },
  },
]);

/**
 * First-party machine clients that hold one owner bearer per subject: the
 * console and the connector runtime. They mint on every start or run, so a
 * device-flow approval for one of them returns the subject's live bearer for
 * that client instead of adding a new one.
 */
export const REUSED_OWNER_BEARER_CLIENT_IDS: readonly string[] = Object.freeze([
  CONSOLE_OWNER_CLIENT_ID,
  CONNECTOR_RUNTIME_OWNER_CLIENT_ID,
]);

/**
 * Clients earlier versions pre-registered and no longer do: the console's
 * and the connector runtime's old owner clients, and the demo apps. Startup
 * revokes their credentials and deregisters them
 * (`retireFormerPreRegisteredClients` in stores/owner-session-store.ts).
 */
export const RETIRED_PRE_REGISTERED_CLIENT_IDS: readonly string[] = Object.freeze([
  "pdpp-polyfill-owner-bootstrap",
  "cli_longview",
  "longview",
  "longview_planning_v1",
  "concert_recommendation_app",
]);
