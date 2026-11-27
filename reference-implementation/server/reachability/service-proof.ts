// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServiceVerifier } from "@tnunamak/gozar";

const path = "/.well-known/gozar/service";
const verify = createServiceVerifier();

export function respondToServiceProof(req: IncomingMessage, res: ServerResponse): void {
  if (process.env.PDPP_MANAGED_DESKTOP_HOST === "1" && process.env.HOSTNAME === "127.0.0.1") {
    // Next may rewrite the pathname to its native HTTP handler. Preserve the
    // original query and let the SDK validate the nonce, Host and real socket.
    const query = req.url?.match(/\?.*$/)?.[0] ?? "";
    const { method, rawHeaders, headers, socket } = req;
    if (verify({ method, rawHeaders, headers, socket, url: path + query }, res)) return;
  }
  res.writeHead(404, { "Cache-Control": "no-store" }).end();
}
