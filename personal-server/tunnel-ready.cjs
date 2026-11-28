// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// frpc prints this only after the FRP server accepts the proxy, so the public
// URL serves traffic. "login to server success" comes earlier and also appears
// when the proxy registration fails, so it does not prove the URL works.
const PROXY_READY_MARKER = 'start proxy success';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Wait until frpc reports that its proxy is up.
 *
 * Resolves `publicUrl` when frpc prints "start proxy success". Resolves null
 * when frpc fails to start, exits first, or stays silent for `timeoutMs`.
 * Callers must announce no URL on null.
 */
function waitForTunnelReady(frpc, publicUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // A marker can arrive split across two chunks, so keep a short tail per stream.
    const watch = (stream) => {
      let tail = '';
      stream?.on('data', (data) => {
        const text = tail + data.toString();
        if (text.includes(PROXY_READY_MARKER)) settle(publicUrl);
        tail = text.slice(-PROXY_READY_MARKER.length);
      });
    };
    watch(frpc.stdout);
    watch(frpc.stderr);

    frpc.on('error', () => settle(null));
    frpc.on('exit', () => settle(null));
    timer = setTimeout(() => settle(null), timeoutMs);
  });
}

module.exports = { waitForTunnelReady };
