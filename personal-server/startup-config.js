// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Avoid provisioning tunnel infrastructure unless the wrapper can start it. */
export function applyTunnelStartupPolicy(config, hasExternalServiceConfiguration) {
  if (hasExternalServiceConfiguration) return config;

  config.tunnel ??= {};
  config.tunnel.enabled = false;
  return config;
}
